// @ts-nocheck
// TypeScript types are provided by pi at runtime via jiti.
// This extension uses runtime-only imports; type checking is skipped.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";

// ── Configuration ─────────────────────────────────────────────────────

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const SETUP_SCRIPT_PATH = path.join(PACKAGE_ROOT, "scripts", "setup.sh");

const PI_SIGNAL_ACCOUNT = process.env.PI_SIGNAL_ACCOUNT || "";

// REST API base URL for bbernhard/signal-cli-rest-api
const SIGNAL_DAEMON_URL =
	process.env.PI_SIGNAL_DAEMON_URL || "http://127.0.0.1:8090";

// When running multiple pi instances, only the primary instance should
// process Signal messages.
const PI_SIGNAL_PRIMARY =
	process.env.PI_SIGNAL_PRIMARY === "true" ||
	process.env.PI_SIGNAL_PRIMARY === "1" ||
	process.env.PI_SIGNAL_PRIMARY === "yes";

// Allowlist of phone numbers (comma-separated, E.164 format, no spaces).
const PI_SIGNAL_ALLOWLIST = (process.env.PI_SIGNAL_ALLOWLIST || "").trim();

// Parse the allowlist into a Set of normalized E.164 numbers.
const ALLOWED_NUMBERS = new Set(
	PI_SIGNAL_ALLOWLIST.split(",")
		.map((n) => n.replace(/[\s\-().]/g, ""))
		.filter((n) => /^[+]?\d+$/.test(n)),
);

// Helper: check whether a number is allowed.
// Default behaviour: only PI_SIGNAL_ACCOUNT (self) is allowed.
// If PI_SIGNAL_ALLOWLIST is set, those numbers are additionally allowed.
function isAllowedNumber(number: string): boolean {
	const cleaned = number.replace(/[\s\-().]/g, "");
	// Self is always allowed
	if (cleaned === PI_SIGNAL_ACCOUNT) return true;
	// If allowlist is set, check against it
	if (PI_SIGNAL_ALLOWLIST) {
		return ALLOWED_NUMBERS.has(cleaned);
	}
	// Empty allowlist = only self allowed
	return false;
}

// Default stats mode
const DEFAULT_STATS_MODE = (
	process.env.PI_SIGNAL_STATS || "short"
).toLowerCase();

// SSE reconnect backoff (kept for compatibility with status reporting)
const SSE_RETRY_DELAY_INITIAL = 2000;
const SSE_RETRY_DELAY_MAX = 60_000;

// ── REST API helper ───────────────────────────────────────────────────

/**
 * Issue a REST request to the bbernhard/signal-cli-rest-api container.
 * This replaces the old JSON-RPC daemonRpc() calls.
 */
async function restApi(
	method: "GET" | "POST" | "PUT" | "DELETE",
	path: string,
	body?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
	const baseUrl = new URL(SIGNAL_DAEMON_URL);
	const url = new URL(path, SIGNAL_DAEMON_URL);
	// Use the hostname/port from the base URL but keep the path
	const target = new URL(path, SIGNAL_DAEMON_URL);

	const isHttps = baseUrl.protocol === "https:";
	const lib = isHttps ? https : http;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	const opts: http.RequestOptions = {
		hostname: target.hostname,
		port: target.port || (isHttps ? 443 : 80),
		path: target.pathname + (target.search || ""),
		method,
		headers,
		timeout: 15000,
	};

	return new Promise((resolve) => {
		const req = lib.request(opts, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					try {
						resolve({ ok: true, result: JSON.parse(raw) });
					} catch {
						// No content (204) or non-JSON
						if (raw.trim()) {
							resolve({ ok: true, result: raw });
						} else {
							resolve({ ok: true, result: null });
						}
					}
				} else {
					try {
						const err = JSON.parse(raw);
						resolve({ ok: false, error: err?.error || "unknown error" });
					} catch {
						resolve({ ok: false, error: `HTTP ${res.statusCode || "unknown"}` });
					}
				}
			});
		});

		req.on("error", (err) => {
			resolve({ ok: false, error: err.message });
		});

		req.on("timeout", () => {
			req.destroy();
			resolve({ ok: false, error: "request timeout" });
		});

		if (body) {
			req.write(JSON.stringify(body));
		}
		req.end();
	});
}

/** Send a signal message via the REST API. */
async function sendMessage(
	recipient: string,
	message: string,
): Promise<boolean> {
	const res = await restApi("POST", "/v1/send", {
		number: PI_SIGNAL_ACCOUNT,
		recipients: [recipient],
		message,
	});
	return res.ok;
}

/** Send an emoji reaction via the REST API. */
async function sendReaction(
	recipient: string,
	targetAuthor: string,
	timestamp: number,
	emoji: string,
): Promise<boolean> {
	const res = await restApi("POST", `/v1/reactions/${encodeURIComponent(PI_SIGNAL_ACCOUNT)}`, {
		reaction: emoji,
		recipient,
		target_author: targetAuthor,
		timestamp,
	});
	return res.ok;
}

/** Remove a reaction via the REST API. */
async function removeReaction(
	recipient: string,
	targetAuthor: string,
	timestamp: number,
): Promise<boolean> {
	const res = await restApi("DELETE", `/v1/reactions/${encodeURIComponent(PI_SIGNAL_ACCOUNT)}`, {
		recipient,
		target_author: targetAuthor,
		timestamp,
	});
	return res.ok;
}

/** List contacts via the REST API. */
async function listContacts(): Promise<Array<Record<string, unknown>>> {
	const res = await restApi("GET", `/v1/contacts/${encodeURIComponent(PI_SIGNAL_ACCOUNT)}?all_recipients=true`);
	if (!res.ok || !Array.isArray(res.result)) {
		console.log(`[signal] listContacts failed: ${res.error || "unknown"}`);
		return [];
	}
	return res.result as Array<Record<string, unknown>>;
}

/** Get the about/version info of the API. */
async function getApiAbout(): Promise<{ ok: boolean; version?: string }> {
	const res = await restApi("GET", "/v1/about");
	if (!res.ok) return { ok: false };
	const data = res.result as Record<string, unknown> | undefined;
	return {
		ok: true,
		version: (data?.version as string) || undefined,
	};
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// WebSocket / SSE state (WebSocket for json-rpc-native mode)
	let wsConnected = false;
	let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let wsReconnectDelay = SSE_RETRY_DELAY_INITIAL;

	// Resolved Signal UUID (ACI) for our own account
	let resolvedAccountId: string | null = null;

	// Pending reaction (Note-to-Self feedback cycle)
	let pendingReaction: {
		recipient: string;
		targetAuthor: string;
		timestamp: number;
	} | null = null;

	// Track the current Signal sender context so we can send the agent's
	// response back to Signal automatically.
	let currentSignalSender: {
		number: string;
		sender: string;
		timestamp: number;
	} | null = null;

	// ── Feature state ────────────────────────────────────────────────

	let extCtx: ExtensionContext | null = null;
	let statsMode: "off" | "short" | "full" =
		DEFAULT_STATS_MODE === "full" ? "full"
		: DEFAULT_STATS_MODE === "off" ? "off"
		: "short";
	let paused = false;
	let lastAgentReply: string | null = null;

	/**
	 * Parse a message from the REST API WebSocket format.
	 * The WebSocket in json-rpc-native mode sends JSON like:
	 * { account: "+27727924107", envelope: { source, sourceNumber, sourceUuid, dataMessage, ... } }
	 */
	function parseEnvelope(data: string): {
		sender: string;
		number: string;
		body: string;
		timestamp: number;
	} | null {
		let raw: unknown;
		try {
			raw = JSON.parse(data);
		} catch {
			return null;
		}
		if (!raw || typeof raw !== "object") return null;

		const obj = raw as Record<string, unknown>;

		// Extract envelope (the REST API wraps it under "envelope" key)
		const env = obj.envelope as Record<string, unknown> | undefined;
		if (!env) return null;

		// Extract message body
		let body: string | undefined;
		let isNoteToSelf = false;

		// Check dataMessage (normal incoming messages)
		if (env.dataMessage && typeof env.dataMessage === "object") {
			const dm = env.dataMessage as Record<string, unknown>;
			body = (dm.body as string | undefined) || (dm.message as string | undefined);
		}

		// Check syncMessage (Note to Self / synced from other devices)
		if (!body && env.syncMessage && typeof env.syncMessage === "object") {
			const sm = env.syncMessage as Record<string, unknown>;
			if (sm.sentMessage && typeof sm.sentMessage === "object") {
				const sentMsg = sm.sentMessage as Record<string, unknown>;
				const destination =
					(sentMsg.destinationNumber as string | undefined) ||
					(sentMsg.destination as string | undefined);
				body =
					(sentMsg.message as string | undefined) ||
					(sentMsg.body as string | undefined);
				if (body && PI_SIGNAL_ACCOUNT && destination === PI_SIGNAL_ACCOUNT) {
					isNoteToSelf = true;
				} else if (body) {
					// A synced message to someone else — ignore it.
					return null;
				}
			}
			if (!body) {
				body =
					(sm.body as string | undefined) || (sm.message as string | undefined);
			}
		}
		if (!body || typeof body !== "string" || body.trim() === "") return null;

		// Extract message timestamp
		let timestamp: number = 0;
		if (env.dataMessage && typeof env.dataMessage === "object") {
			timestamp = ((env.dataMessage as Record<string, unknown>).timestamp as number) || 0;
		}
		if (!timestamp && isNoteToSelf && env.syncMessage && typeof env.syncMessage === "object") {
			const sm = env.syncMessage as Record<string, unknown>;
			if (sm.sentMessage && typeof sm.sentMessage === "object") {
				timestamp = ((sm.sentMessage as Record<string, unknown>).timestamp as number) || 0;
			}
		}

		// Extract sender number
		let number = "unknown";
		if (isNoteToSelf && PI_SIGNAL_ACCOUNT) {
			number = PI_SIGNAL_ACCOUNT;
		} else if (typeof env.sourceNumber === "string" && env.sourceNumber) {
			number = env.sourceNumber;
		} else if (typeof env.source === "string" && env.source) {
			number = env.source;
		}

		// Extract sender display name
		let sender: string = number;
		if (isNoteToSelf) {
			sender = "Self";
		} else if (typeof env.sourceName === "string" && env.sourceName) {
			sender = env.sourceName;
		}

		return { sender, number, body: body.trim(), timestamp };
	}

	// ── Command Handlers ────────────────────────────────────────────

	function buildStatsFooter(
		ctx: ExtensionContext | null,
	): string {
		if (!ctx || statsMode === "off") return "";

		const usage = ctx.getContextUsage?.();
		const model = ctx.model;
		const modelName = model?.name || model?.id || "unknown";
		const provider = model?.provider || "";

		const tokensIn = usage?.tokens != null ? usage.tokens : null;
		const pct = usage?.percent != null ? usage.percent : null;

		if (statsMode === "short") {
			const parts: string[] = [modelName];
			if (tokensIn != null) {
				parts.push(formatTokens(tokensIn) + " ctx");
			}
			if (pct != null) {
				parts.push(Math.round(pct) + "%");
			}
			return "\n───\n" + parts.join(" · ");
		}

		const ctxWindow = usage?.contextWindow || null;
		const lines: string[] = ["───"];
		lines.push(`Model: ${modelName}${provider ? " (" + provider + ")" : ""}`);
		if (tokensIn != null) {
			lines.push(`Context: ${tokensIn.toLocaleString()} tokens`);
		}
		if (ctxWindow != null) {
			lines.push(`Window: ${ctxWindow.toLocaleString()} tokens`);
		}
		if (pct != null) {
			lines.push(`Usage: ${Math.round(pct)}%`);
		}
		return "\n" + lines.join("\n");
	}

	function formatTokens(n: number): string {
		if (n >= 1000) return (n / 1000).toFixed(1) + "K";
		return String(n);
	}

	function sanitizeContactName(s: string): string {
		return s
			.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 100);
	}

	function levenshtein(a: string, b: string): number {
		const m = a.length;
		const n = b.length;
		const dp: number[][] = [];
		for (let i = 0; i <= m; i++) {
			dp[i] = [i];
		}
		for (let j = 0; j <= n; j++) {
			dp[0][j] = j;
		}
		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				dp[i][j] = a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1]
					: Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]) + 1;
			}
		}
		return dp[m][n];
	}

	function fuzzyMatchModels(
		query: string,
		models: Array<{ label: string; model: unknown }>,
	): Array<{ label: string; model: unknown; score: number }> {
		const q = query.toLowerCase().trim();
		if (!q) return [];

		const scored: Array<{ label: string; model: unknown; score: number }> = [];

		for (const entry of models) {
			const label = entry.label.toLowerCase();
			let score = Infinity;

			if (label === q) {
				score = 0;
			} else if (label.includes(q)) {
				const pos = label.indexOf(q);
				score = 0.02 + (pos / Math.max(label.length, 1)) * 0.05;
			} else {
				const dist = levenshtein(label, q);
				const maxLen = Math.max(label.length, q.length);
				score = dist / Math.max(maxLen, 1);
			}

			scored.push({ label: entry.label, model: entry.model, score });
		}

		scored.sort((a, b) => {
			if (a.score !== b.score) return a.score - b.score;
			return a.label.length - b.label.length;
		});

		return scored;
	}

	function getModelList(ctx: ExtensionContext): Array<{ label: string; model: unknown }> {
		const registry = ctx.modelRegistry;
		if (!registry || typeof registry.getAll !== "function") return [];

		try {
			const models = registry.getAll() as Array<{
				provider?: string;
				id?: string;
				name?: string;
			}>;
			return models.map((m) => ({
				label: `${m.name || m.id || "unknown"} (${m.provider || "?"}/${m.id || "?"})`,
				model: m,
			}));
		} catch {
			return [];
		}
	}

	async function handleCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		cmd: string,
		args: string[],
	): Promise<void> {
		const ctx = extCtx;
		if (!ctx) {
			forwardToAgent(parsed);
			return;
		}

		const reply = (text: string) => {
			currentSignalSender = {
				number: parsed.number,
				sender: parsed.sender,
				timestamp: parsed.timestamp,
			};
			sendToSignal(parsed.number, text).then((ok) => {
				if (ok) {
					console.log(`[signal] command reply sent: ${cmd}`);
				} else {
					console.error(`[signal] failed to send command reply: ${cmd}`);
				}
			}).finally(() => {
				currentSignalSender = null;
			});
		};

		switch (cmd) {
			case "model":
				return handleModelCommand(ctx, args, reply);
			case "abort":
				return handleAbortCommand(ctx, parsed, reply);
			case "clear":
				return handleClearCommand(ctx, parsed, reply);
			case "stats":
				return handleStatsCommand(parsed, args, reply);
			case "status":
				return handleStatusCommand(parsed, reply);
			case "resend":
				return handleResendCommand(parsed, reply);
			case "whoami":
				return handleWhoamiCommand(parsed, reply);
			case "pause":
				return handlePauseCommand(parsed, reply);
			case "resume":
				return handleResumeCommand(parsed, reply);
			case "help":
				return handleHelpCommand(parsed, reply);
			default:
				forwardToAgent(parsed);
		}
	}

	async function handleModelCommand(
		ctx: ExtensionContext,
		args: string[],
		reply: (text: string) => void,
	): Promise<void> {
		const query = args.join(" ").trim();
		if (!query) {
			const current = ctx.model;
			const name = current?.name || current?.id || "unknown";
			reply(`Current model: ${name} (${current?.provider || "?"})\n\nUsage: /model <partial name>\nExamples: /model claude, /model gpt, /model sonnet`);
			return;
		}

		const models = getModelList(ctx);
		if (models.length === 0) {
			reply("No models available. Configure a provider first.");
			return;
		}

		const matches = fuzzyMatchModels(query, models);

		const qLower = query.toLowerCase().trim();
		for (const entry of models) {
			const entryObj = entry.model as { id?: string };
			if (entryObj.id && entryObj.id.toLowerCase() === qLower) {
				const ok = await pi.setModel(entry.model as any);
				if (ok) {
					reply(`Switched to ${entry.label}`);
				} else {
					reply(`Failed to switch to ${entry.label}. Check API key configuration.`);
				}
				return;
			}
		}

		const good = matches.filter((m) => m.score < 0.5);
		if (good.length === 0) {
			const closest = matches.slice(0, 5);
			const lines = closest.map((m, i) => `${i + 1}. ${m.label}`);
			reply(
				`No close match for "${query}". Did you mean:\n${lines.join("\n")}`,
			);
			return;
		}

		const best = good[0];
		if (good.length === 1 && best.score < 0.15) {
			const ok = await pi.setModel(best.model as any);
			if (ok) {
				reply(`Switched to ${best.label}`);
			} else {
				reply(`Failed to switch to ${best.label}. Check API key configuration.`);
			}
			return;
		}

		const show = good.slice(0, 10);
		const lines = show.map((m, i) => `${i + 1}. ${m.label}`);
		reply(
			`Multiple matches for "${query}":\n${lines.join("\n")}\n\nSend a more specific query.`,
		);
	}

	async function handleAbortCommand(
		ctx: ExtensionContext,
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		if (ctx.isIdle()) {
			reply("Nothing to abort — the agent is idle.");
			return;
		}

		ctx.abort();
		reply("⏹ Response aborted.");

		if (parsed.timestamp) {
			await removeReaction(parsed.number, parsed.number, parsed.timestamp);
			await sendReaction(parsed.number, parsed.number, parsed.timestamp, "🛑");
		}
	}

	async function handleClearCommand(
		ctx: ExtensionContext,
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		if (!ctx.isIdle()) {
			ctx.abort();
			await new Promise((r) => setTimeout(r, 300));
		}

		reply("🧹 Starting new session…");

		try {
			if (typeof (ctx as any).newSession === "function") {
				await (ctx as any).newSession({
					withSession: async (_newCtx: unknown) => {
						console.log("[signal] new session started via /clear");
					},
				});
			} else {
				console.log("[signal] newSession not available on context");
			}
		} catch (err) {
			console.error("[signal] /clear error:", err);
		}
	}

	async function handleStatsCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		args: string[],
		reply: (text: string) => void,
	): Promise<void> {
		const arg = args[0]?.toLowerCase();

		if (!arg) {
			const ctx = extCtx;
			let usageLine = "";
			if (ctx) {
				const usage = ctx.getContextUsage?.();
				if (usage?.percent != null) {
					usageLine = ` · ${Math.round(usage.percent)}% context used`;
				}
			}
			reply(`Stats mode: ${statsMode}${usageLine}\n\nUsage:\n/stats short — enable short stats (default)\n/stats full  — enable full stats\n/stats off   — disable stats`);
			return;
		}

		if (arg === "short" || arg === "full" || arg === "off") {
			statsMode = arg;
			reply(`Stats mode set to: ${arg}`);
		} else {
			reply(`Invalid stats mode "${arg}". Use: short, full, off`);
		}
	}

	function forwardToAgent(parsed: {
		sender: string;
		number: string;
		body: string;
		timestamp: number;
	}) {
		currentSignalSender = {
			number: parsed.number,
			sender: parsed.sender,
			timestamp: parsed.timestamp,
		};

		if (parsed.timestamp) {
			pendingReaction = {
				recipient: parsed.number,
				targetAuthor: parsed.number,
				timestamp: parsed.timestamp,
			};
			sendReaction(parsed.number, parsed.number, parsed.timestamp, "👀").then(
				(ok) => {
					if (!ok) console.error("[signal] failed to send 👀 reaction");
				},
			);
		}

		const formatted = `[Signal from ${parsed.sender} (${parsed.number})]: ${parsed.body}`;
		pi.sendUserMessage(formatted, { deliverAs: "followUp" });
	}

	async function handleHelpCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		reply(
			"Available commands:\n" +
			"/model <name> — switch model (fuzzy match)\n" +
			"/abort — stop current generation\n" +
			"/clear — start new session\n" +
			"/stats [short|full|off] — toggle usage stats\n" +
			"/status — show live connection & model info\n" +
			"/whoami — show model, directory, and session\n" +
			"/resend — resend the last reply\n" +
			"/pause — stop processing incoming messages\n" +
			"/resume — resume processing\n" +
			"/help — show this help",
		);
	}

	async function handleStatusCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		const ctx = extCtx;
		const model = ctx?.model;
		const modelName = model?.name || model?.id || "unknown";
		const providerSuffix = model?.provider ? ` (${model.provider})` : "";
		const lines = [
			"✅ pi is up and receiving Signal.",
			`Account: ${PI_SIGNAL_ACCOUNT || "(not set)"}`,
			`Primary: ${PI_SIGNAL_PRIMARY ? "yes" : "no"}`,
			`REST API: ${wsConnected ? "connected" : "disconnected"}`,
			`Model: ${modelName}${providerSuffix}`,
			`Stats: ${statsMode}`,
			`State: ${paused ? "⏸ paused (send /resume)" : "active"}`,
		];
		reply(lines.join("\n"));
	}

	async function handleResendCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		if (!lastAgentReply) {
			reply("Nothing to resend yet.");
			return;
		}
		reply(lastAgentReply);
	}

	async function handleWhoamiCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		const ctx = extCtx;
		const model = ctx?.model;
		const modelName = model?.name || model?.id || "unknown";
		const providerSuffix = model?.provider ? ` (${model.provider})` : "";
		let sessionName: string | undefined;
		try {
			sessionName = pi.getSessionName?.();
		} catch {
			sessionName = undefined;
		}
		const lines = [
			`Model: ${modelName}${providerSuffix}`,
			`Directory: ${ctx?.cwd || "unknown"}`,
			`Session: ${sessionName || "(unnamed)"}`,
			`Account: ${PI_SIGNAL_ACCOUNT || "(not set)"}`,
			`Primary: ${PI_SIGNAL_PRIMARY ? "yes" : "no"}`,
		];
		reply(lines.join("\n"));
	}

	async function handlePauseCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		if (paused) {
			reply("Already paused. Send /resume to re-enable.");
			return;
		}
		paused = true;
		reply(
			"⏸ Paused. Incoming messages will be ignored until you send /resume. Commands still work.",
		);
	}

	async function handleResumeCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		if (!paused) {
			reply("Not paused — messages are already being processed.");
			return;
		}
		paused = false;
		reply("▶️ Resumed. Messages will be processed again.");
	}

	function injectMessage(parsed: {
		sender: string;
		number: string;
		body: string;
		timestamp: number;
	}) {
		// Note-to-Self messages: only process from own account
		if (parsed.number === PI_SIGNAL_ACCOUNT) {
			const body = parsed.body.trim();
			if (body.startsWith("/")) {
				const parts = body.slice(1).split(/\s+/);
				const cmd = parts[0].toLowerCase();
				const args = parts.slice(1);
				handleCommand(parsed, cmd, args).catch((err) => {
					console.error(`[signal] command error (${cmd}):`, err);
				});
			} else if (!paused) {
				forwardToAgent(parsed);
			}
			return;
		}

		// Messages from others: check allowlist
		if (!isAllowedNumber(parsed.number)) {
			console.log(
				`[signal] blocked message from ${parsed.number} (not in allowlist)`,
			);
			if (parsed.timestamp) {
				pendingReaction = {
					recipient: parsed.number,
					targetAuthor: parsed.number,
					timestamp: parsed.timestamp,
				};
				sendReaction(parsed.number, parsed.number, parsed.timestamp, "🚫")
					.then(() => {
						sendToSignal(parsed.number, "⛔ Your number is not in the allowlist. Contact the admin to be added.").catch(() => {});
					})
					.catch(() => {});
			}
			return;
		}

		// Check for commands
		const body = parsed.body.trim();
		if (body.startsWith("/")) {
			const parts = body.slice(1).split(/\s+/);
			const cmd = parts[0].toLowerCase();
			const args = parts.slice(1);
			handleCommand(parsed, cmd, args).catch((err) => {
				console.error(`[signal] command error (${cmd}):`, err);
			});
			return;
		}

		// Normal message — forward to agent, unless paused
		if (paused) {
			sendToSignal(parsed.number, "⏸ Paused. Send /resume to re-enable.").catch(
				() => {},
			);
			return;
		}
		forwardToAgent(parsed);
	}

	// ── WebSocket Listener (for json-rpc-native mode) ───────────────

	/**
	 * Connect to the bbernhard REST API WebSocket endpoint for receiving
	 * messages. In json-rpc-native mode, /v1/receive/{number} is a WebSocket.
	 * Format: { account, envelope: { source, sourceNumber, dataMessage, ... } }
	 */
	function startWebSocketListener(): void {
		if (!PI_SIGNAL_PRIMARY) {
			console.log(
				"[signal] PI_SIGNAL_PRIMARY is not set — skipping WebSocket listener.",
			);
			return;
		}

		if (!PI_SIGNAL_ACCOUNT) {
			console.warn("[signal] PI_SIGNAL_ACCOUNT is not set — cannot start WebSocket listener.");
			return;
		}

		doWebSocketConnect();
	}

	function doWebSocketConnect() {
		cleanupWebSocket();

		const baseUrl = new URL(SIGNAL_DAEMON_URL);
		const wsPath = `/v1/receive/${encodeURIComponent(PI_SIGNAL_ACCOUNT)}?timeout=30`;

		const isHttps = baseUrl.protocol === "https:";
		const lib = isHttps ? https : http;

		const protocol = isHttps ? "wss://" : "ws://";
		const wsUrl = `${protocol}${baseUrl.hostname}:${baseUrl.port || 80}${wsPath}`;

		console.log(`[signal] connecting WebSocket to ${wsUrl}`);

		try {
			const ws = new WebSocket(wsUrl);

			ws.onopen = () => {
				console.log("[signal] WebSocket connected — listening for incoming messages");
				wsConnected = true;
				wsReconnectDelay = SSE_RETRY_DELAY_INITIAL;
			};

			ws.onmessage = (event: MessageEvent) => {
				const data = typeof event.data === "string" ? event.data : event.data.toString("utf8");
				if (!data.trim()) return;

				const parsed = parseEnvelope(data);
				if (parsed) {
					injectMessage(parsed);
				}
			};

			ws.onerror = (err: Event) => {
				console.error("[signal] WebSocket error:", err);
				wsConnected = false;
			};

			ws.onclose = (event: CloseEvent) => {
				console.log(`[signal] WebSocket closed (code: ${event.code})`);
				wsConnected = false;
				scheduleWsReconnect();
			};

			// Store the WebSocket for cleanup
			(ws as any).__cleanup = ws.close.bind(ws);
			(globalThis as any).__signalWs = ws;
		} catch (err) {
			console.error(`[signal] WebSocket connection error: ${(err as Error).message}`);
			wsConnected = false;
			scheduleWsReconnect();
		}
	}

	function scheduleWsReconnect() {
		if (wsReconnectTimer) return;

		const delay = wsReconnectDelay;
		console.log(`[signal] reconnecting WebSocket in ${delay}ms`);

		wsReconnectTimer = setTimeout(() => {
			wsReconnectTimer = null;
			wsReconnectDelay = Math.min(
				wsReconnectDelay * 2,
				SSE_RETRY_DELAY_MAX,
			);
			doWebSocketConnect();
		}, delay);
	}

	function cleanupWebSocket() {
		if (wsReconnectTimer) {
			clearTimeout(wsReconnectTimer);
			wsReconnectTimer = null;
		}
		const ws = (globalThis as any).__signalWs;
		if (ws && typeof ws.close === "function") {
			try { ws.close(); } catch {}
		}
		(globalThis as any).__signalWs = null;
		wsConnected = false;
	}

	// ── Account ID resolution ──────────────────────────────────────

	/**
	 * Resolve our own phone number to a Signal UUID by calling the contacts endpoint.
	 */
	async function resolveAccountId(): Promise<string | null> {
		if (!PI_SIGNAL_ACCOUNT) return null;

		const contacts = await listContacts();
		for (const contact of contacts) {
			const number = (contact.number as string) || "";
			if (number && number === PI_SIGNAL_ACCOUNT) {
				const uuid = (contact.uuid as string) || (contact.aci as string) || null;
				if (uuid) {
					console.log(`[signal] resolved account UUID: ${uuid}`);
					return uuid;
				}
			}
		}

		console.log("[signal] account not found in contacts — using phone number");
		return null;
	}

	// ── Send response back to Signal ──────────────────────────────

	/**
	 * Send a text message back to Signal via the REST API.
	 * For self-messages (Note-to-Self), use the resolved UUID so the message
	 * routes through sendSelfMessage → grey (synced) rendering.
	 */
	async function sendToSignal(
		_recipient: string,
		message: string,
	): Promise<boolean> {
		if (!message || !message.trim()) return false;

		const maxLen = 7800;
		let text = message.trim();
		if (text.length > maxLen) {
			text =
				text.slice(0, maxLen) +
				"\n\n[truncated — response too long for Signal]";
		}

		const targetId = resolvedAccountId || PI_SIGNAL_ACCOUNT;
		const ok = await sendMessage(targetId, text);
		return ok;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event: unknown, ctx: unknown) => {
		extCtx = ctx as ExtensionContext | null;

		resolvedAccountId = await resolveAccountId();

		startWebSocketListener();
	});

	// Auto-send agent responses back to Signal, with stats footer
	pi.on("agent_end", async (event: unknown, ctx: unknown) => {
		if (!currentSignalSender) return;

		const sender = currentSignalSender;
		currentSignalSender = null;

		try {
			const messages =
				(event as { messages?: Array<{ role?: string; content?: unknown }> })
					.messages ?? [];
			const assistantMessages = messages.filter((m) => m.role === "assistant");

			if (assistantMessages.length === 0) return;

			const textParts: string[] = [];
			for (const msg of assistantMessages) {
				const content = msg.content;
				if (typeof content === "string") {
					textParts.push(content);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							part &&
							typeof part === "object" &&
							(part as { type?: string }).type === "text"
						) {
							const text = (part as { text?: string }).text;
							if (text) textParts.push(text);
						}
					}
				}
			}

			let fullText = textParts.join("\n").trim();
			if (!fullText) return;

			if (statsMode !== "off") {
				const statsFooter = buildStatsFooter(ctx as ExtensionContext | null);
				if (statsFooter) {
					fullText += statsFooter;
				}
			}

			lastAgentReply = fullText;

			const ok = await sendToSignal(sender.number, fullText);
			if (ok) {
				console.log(`[signal] auto-reply sent to ${sender.number}`);
				if (sender.timestamp) {
					await removeReaction(sender.number, sender.number, sender.timestamp);
					await sendReaction(
						sender.number,
						sender.number,
						sender.timestamp,
						"✅",
					);
				}
			} else {
				console.error(`[signal] failed to auto-reply to ${sender.number}`);
				if (sender.timestamp) {
					await removeReaction(sender.number, sender.number, sender.timestamp);
					await sendReaction(
						sender.number,
						sender.number,
						sender.timestamp,
						"❌",
					);
				}
			}
		} catch (err) {
			console.error("[signal] auto-reply error:", err);
		}
	});

	pi.on("model_select", async (event: unknown) => {
		const ev = event as { model?: { name?: string; id?: string } };
		if (ev?.model) {
			console.log(
				`[signal] model switched to ${ev.model.name || ev.model.id || "unknown"}`,
			);
		}
	});

	pi.on("session_shutdown", async () => {
		cleanupWebSocket();
	});

	// ── Tool: signal_send ──────────────────────────────────────────

	pi.registerTool({
		name: "signal_send",
		label: "Signal Send",
		description:
			"Send a text message to a Signal user. " +
			"Recipient must be a phone number in E.164 format, e.g. +1234567890. " +
			"To send to someone by name, first resolve their number with " +
			"signal_list_contacts, then call this with that number. " +
			"Uses the bbernhard/signal-cli-rest-api REST API.",
		parameters: Type.Object({
			recipient: Type.String({
				description:
					"Recipient phone number in E.164 format, e.g. +1234567890. Include the leading +.",
			}),
			message: Type.String({ description: "The message text to send." }),
		}),
		async execute(
			_toolCallId: string,
			params: { recipient: string; message: string },
			_signal?: AbortSignal,
		) {
			const cleaned = params.recipient.replace(/[\s\-().]/g, "");
			if (!/^\+[1-9]\d{1,14}$/.test(cleaned)) {
				throw new Error(
					`Invalid recipient "${params.recipient}". Must be E.164 format, e.g. +1234567890.`,
				);
			}

			if (!isAllowedNumber(cleaned)) {
				throw new Error(
					`Recipient ${cleaned} is not in the Signal allowlist. Only messages to allowed numbers can be sent.`,
				);
			}

			const isSelf = cleaned === PI_SIGNAL_ACCOUNT;
			const targetId = isSelf && resolvedAccountId ? resolvedAccountId : cleaned;
			const ok = await sendMessage(targetId, params.message);

			if (!ok) {
				throw new Error(`Failed to send Signal message.`);
			}

			if (pendingReaction) {
				const pr = pendingReaction;
				pendingReaction = null;
				removeReaction(pr.recipient, pr.targetAuthor, pr.timestamp)
					.then(() => {
						sendReaction(
							pr.recipient,
							pr.targetAuthor,
							pr.timestamp,
							"✅",
						).catch(() => {});
					})
					.catch(() => {});
			}

			if (cleaned === PI_SIGNAL_ACCOUNT) {
				currentSignalSender = null;
			}

			return {
				content: [{ type: "text", text: `Message sent to ${cleaned}.` }],
				details: {
					recipient: cleaned,
					message: params.message,
				},
			};
		},
	});

	// ── Tool: signal_status ───────────────────────────────────────

	pi.registerTool({
		name: "signal_status",
		label: "Signal Status",
		description:
			"Check whether the bbernhard/signal-cli-rest-api is running, " +
			"and the WebSocket connection is established.",
		parameters: Type.Object({}),
		async execute(
			_toolCallId: string,
			_params: Record<string, unknown>,
			_signal?: AbortSignal,
		) {
			const lines: string[] = [];

			lines.push(`Account: ${PI_SIGNAL_ACCOUNT || "(not set)"}`);

			// Check REST API connectivity
			const about = await getApiAbout();
			lines.push(
				`REST API (${SIGNAL_DAEMON_URL}): ${about.ok ? `✓ v${about.version || "?"}` : "✗ not reachable"}`,
			);

			lines.push(`WebSocket: ${wsConnected ? "✓ connected" : "✗ disconnected"}`);
			lines.push(`Stats mode: ${statsMode}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { lines },
			};
		},
	});

	// ── Tool: signal_list_contacts ────────────────────────────────

	pi.registerTool({
		name: "signal_list_contacts",
		label: "Signal Contacts",
		description:
			"List known Signal contacts as name → phone number pairs. Use this to " +
			"resolve a person's name (e.g. \"Mike\") to their E.164 number BEFORE " +
			"calling signal_send, since signal_send only accepts a phone number. " +
			"Pass an optional `query` to filter by name or number. If more than one " +
			"contact matches, ask the user which one before sending. Names only " +
			"resolve if signal-cli knows them (synced address-book contact name or " +
			"Signal profile name).",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Optional case-insensitive filter. Returns only contacts whose name or number contains this text. Omit to list all contacts.",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { query?: string },
			_signal?: AbortSignal,
		) {
			const contacts = await listContacts();

			const contactList = contacts
				.map((c) => {
					const number = (c.number as string) || "";
					const name =
						(c.name as string) ||
						(c.profileName as string) ||
						[c.givenName, c.familyName]
							.filter((p) => typeof p === "string" && p)
							.join(" ")
							.trim() ||
						(c.username as string) ||
						"";
					return { name: sanitizeContactName(name), number };
				})
				.filter((c) => c.number && c.number !== PI_SIGNAL_ACCOUNT);

			const q = params.query?.toLowerCase().trim();
			const filtered = q
				? contactList.filter(
						(c) =>
							c.name.toLowerCase().includes(q) || c.number.includes(q),
					)
				: contactList;

			filtered.sort(
				(a, b) =>
					(a.name ? 0 : 1) - (b.name ? 0 : 1) || a.name.localeCompare(b.name),
			);

			const lines = filtered.map((c) =>
				c.name ? `${c.name} — ${c.number}` : c.number,
			);
			const text = lines.length
				? lines.join("\n")
				: q
					? `No contacts match "${params.query}".`
					: "No contacts found.";

			return {
				content: [{ type: "text", text }],
				details: { contacts: filtered, query: params.query ?? null },
			};
		},
	});

	// ── Signal Commands (available in TUI) ───────────────────────

	pi.registerCommand("signal-model", {
		description:
			"Switch to a model by fuzzy-matching a partial name. Examples: /signal-model claude, /signal-model sonnet",
		async handler(args: string, ctx: unknown) {
			const extensionCtx = ctx as ExtensionContext;
			const models = getModelList(extensionCtx);
			const query = args.trim();
			if (!query) {
				const current = extensionCtx.model;
				const name = current?.name || current?.id || "unknown";
				(extensionCtx.ui as any)?.notify?.(
					`Current model: ${name} (${current?.provider || "?"})\nUsage: /signal-model <partial name>`,
					"info",
				);
				return;
			}

			const matches = fuzzyMatchModels(query, models);
			const best = matches.find((m) => m.score < 0.15);
			if (best) {
				const ok = await pi.setModel(best.model as any);
				(extensionCtx.ui as any)?.notify?.(
					ok ? `Switched to ${best.label}` : `Failed to switch to ${best.label}`,
					ok ? "info" : "error",
				);
			} else {
				const closest = matches.slice(0, 5).map((m) => m.label).join("\n");
				(extensionCtx.ui as any)?.notify?.(
					`No close match for "${query}". Closest:\n${closest}`,
					"warning",
				);
			}
		},
	});

	pi.registerCommand("signal-abort", {
		description: "Stop the current LLM generation",
		async handler(_args: string, ctx: unknown) {
			const extensionCtx = ctx as ExtensionContext;
			if (extensionCtx.isIdle()) {
				(extensionCtx.ui as any)?.notify?.("Nothing to abort — agent is idle.", "info");
				return;
			}
			extensionCtx.abort();
			(extensionCtx.ui as any)?.notify?.("⏹ Response aborted.", "info");
		},
	});

	pi.registerCommand("signal-stats", {
		description: "View or toggle stats mode. Usage: /signal-stats [short|full|off]",
		async handler(args: string, ctx: unknown) {
			const extensionCtx = ctx as ExtensionContext;
			const arg = args.trim().toLowerCase();
			if (!arg) {
				const usage = extensionCtx.getContextUsage?.();
				const usageLine = usage?.percent != null
					? ` · ${Math.round(usage.percent)}% context used`
					: "";
				(extensionCtx.ui as any)?.notify?.(
					`Stats mode: ${statsMode}${usageLine}`,
					"info",
				);
				return;
			}
			if (arg === "short" || arg === "full" || arg === "off") {
				statsMode = arg;
				(extensionCtx.ui as any)?.notify?.(`Stats mode set to: ${arg}`, "info");
			} else {
				(extensionCtx.ui as any)?.notify?.(
					`Invalid stats mode "${arg}". Use: short, full, off`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("signal-send", {
		description:
			"Send a Signal message from the TUI. Usage: /signal-send <+E164> <message>",
		async handler(args: string, ctx: unknown) {
			const extensionCtx = ctx as {
				ui?: { notify: (msg: string, level: string) => void };
			};

			const trimmed = args.trim();
			const sep = trimmed.indexOf(" ");
			if (sep === -1) {
				extensionCtx.ui?.notify?.(
					"Usage: /signal-send <+E164> <message>",
					"error",
				);
				return;
			}

			const rawNum = trimmed.slice(0, sep);
			const message = trimmed.slice(sep + 1).trim();
			const cleaned = rawNum.replace(/[\s\-().]/g, "");
			if (!/^\+[1-9]\d{1,14}$/.test(cleaned)) {
				extensionCtx.ui?.notify?.(
					`Invalid number "${rawNum}". Use E.164 format, e.g. +1234567890.`,
					"error",
				);
				return;
			}
			if (!message) {
				extensionCtx.ui?.notify?.("Message is empty.", "error");
				return;
			}

			if (!isAllowedNumber(cleaned)) {
				extensionCtx.ui?.notify?.(
					`⛔ ${cleaned} is not in the Signal allowlist. Only messages to allowed numbers can be sent.`,
					"error",
				);
				return;
			}

			const isSelf = cleaned === PI_SIGNAL_ACCOUNT;
			const targetId = isSelf && resolvedAccountId ? resolvedAccountId : cleaned;
			const ok = await sendMessage(targetId, message);

			extensionCtx.ui?.notify?.(
				ok
					? `Message sent to ${cleaned}.`
					: `Send failed.`,
				ok ? "info" : "error",
			);
		},
	});

	// ── Legacy Commands ─────────────────────────────────────────

	pi.registerCommand("signal-setup", {
		description:
			"Interactive setup wizard for Signal ↔ pi integration",
		async handler(_args: string, ctx: unknown) {
			const extensionCtx = ctx as {
				ui?: {
					notify: (msg: string, level: string) => void;
					confirm: (title: string, msg: string) => Promise<boolean>;
				};
			};

			extensionCtx.ui?.notify?.("Starting Signal setup wizard…", "info");
			await setupNativeMode(extensionCtx.ui);
		},
	});

	pi.registerCommand("signal-status", {
		description:
			"Show Signal integration status (account, API health, connection state)",
		async handler(_args: string, ctx: unknown) {
			const extensionCtx = ctx as {
				ui?: { notify: (msg: string, level: string) => void };
			};
			const statusLines: string[] = [];

			if (SIGNAL_DAEMON_URL) {
				const about = await getApiAbout();
				statusLines.push(
					`REST API (${SIGNAL_DAEMON_URL}): ${about.ok ? `✓ v${about.version || "?"}` : "✗ not reachable"}`,
				);
			}

			statusLines.push(`WebSocket: ${wsConnected ? "✓ connected" : "✗ disconnected"}`);
			statusLines.push(`Stats mode: ${statsMode}`);

			const msg = [
				`Account: ${PI_SIGNAL_ACCOUNT || "(not set)"}`,
				``,
				...statusLines,
			].join("\n");

			extensionCtx.ui?.notify?.(msg, "info");
		},
	});

	async function setupNativeMode(ctx: {
		notify?: (msg: string, level: string) => void;
		confirm?: (title: string, msg: string) => Promise<boolean>;
	}): Promise<void> {
		// In REST API mode, setup is just ensuring the Docker container is running
		ctx.notify?.(
			"In REST API mode, Signal integration uses the bbernhard/signal-cli-rest-api " +
			"Docker container. Ensure it's running on " + SIGNAL_DAEMON_URL + ".",
			"info",
		);
	}
}
