// @ts-nocheck
// TypeScript types are provided by pi at runtime via jiti.
// This extension uses runtime-only imports; type checking is skipped.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as attachments from "./attachments.js";
import { createSignalRestClient } from "./rest-client.js";
import { ATTACHMENTS_DIR } from "./attachments.js";
import * as commands from "./commands.js";
import {
	createDebug,
	isLoggingEnabled,
	isAllowedNumber,
	levenshtein,
	fuzzyMatchModels,
	sanitizeContactName,
	buildStatsFooter,
	normalizePhoneNumber,
	isValidE164,
	parseSignalEnvelope,
	formatIncomingMessage,
	extractReplyText,
} from "./utils.js";

// ── Configuration ─────────────────────────────────────────────────────

const debug = createDebug("signal");

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
		.map((n) => normalizePhoneNumber(n))
		.filter((n) => /^[+]?\d+$/.test(n)),
);

// Wrapper for the env-aware isAllowedNumber
function isAllowedNumberLocal(number: string): boolean {
	return isAllowedNumber(number, PI_SIGNAL_ACCOUNT, PI_SIGNAL_ALLOWLIST);
}

// Default stats mode
const DEFAULT_STATS_MODE = (
	process.env.PI_SIGNAL_STATS || "short"
).toLowerCase();

// WebSocket reconnect backoff
const WS_RETRY_DELAY_INITIAL = 2000;
const WS_RETRY_DELAY_MAX = 60_000;

// ── REST client ───────────────────────────────────────────────────────
const {
	sendMessage,
	sendReaction,
	removeReaction,
	sendTypingIndicator,
	listContacts,
	getApiAbout,
} = createSignalRestClient({
	daemonUrl: SIGNAL_DAEMON_URL,
	account: PI_SIGNAL_ACCOUNT,
});

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// WebSocket state (incoming messages via the bbernhard REST API)
	let wsConnected = false;
	let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let wsReconnectDelay = WS_RETRY_DELAY_INITIAL;

	// Resolved Signal UUID (ACI) for our own account
	let resolvedAccountId: string | null = null;

	// Pending reaction (Note-to-Self feedback cycle)
	let pendingReaction: {
		recipient: string;
		targetAuthor: string;
		timestamp: number;
	} | null = null;

	// Numbers with an active typing indicator ("message is being written…"),
	// shown while the agent is working on a response for them.
	const activeTyping = new Set<string>();
	// Per-recipient heartbeat timers that keep the typing indicator alive
	// (signal-cli expires it after ~15 seconds, so we resend every 10s).
	const typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

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
	 * In json-rpc-native mode the WebSocket sends JSON-RPC messages like:
	 * { jsonrpc: "2.0", method: "receive", params: { envelope: {...}, account: "..." } }
	 *
	 * The pure parsing logic lives in parseSignalEnvelope() (utils.ts) so it
	 * can be unit-tested in isolation; this wrapper wires in attachment
	 * downloads against the local REST API.
	 */
	async function parseEnvelope(data: string) {
		return parseSignalEnvelope(
			data,
			PI_SIGNAL_ACCOUNT,
			(dm) =>
				attachments.downloadAttachments(dm, ATTACHMENTS_DIR, SIGNAL_DAEMON_URL),
		);
	}

	// ── Command Handlers ────────────────────────────────────────────

	function buildStatsFooterLocal(
		ctx: ExtensionContext | null,
	): string {
		if (!ctx || statsMode === "off") return "";

		const usage = ctx.getContextUsage?.();
		const model = ctx.model;

		const usageInfo = usage ? {
			tokens: usage.tokens,
			percent: usage.percent,
			contextWindow: usage.contextWindow,
		} : null;

		const modelInfo = model ? {
			name: model.name,
			id: model.id,
			provider: model.provider,
		} : null;

		return buildStatsFooter(usageInfo, modelInfo, statsMode);
	}

	function sanitizeContactNameLocal(s: string): string {
		return sanitizeContactName(s);
	}

	function levenshteinLocal(a: string, b: string): number {
		return levenshtein(a, b);
	}

	function fuzzyMatchModelsLocal(
		query: string,
		models: Array<{ label: string; model: unknown }>,
	): Array<{ label: string; model: unknown; score: number }> {
		const labels = models.map((m) => m.label);
		const results = fuzzyMatchModels(query, labels);
		return results.map((r) => {
			const match = models.find((m) => m.label === r.label);
			return { label: r.label, model: match?.model ?? null, score: r.score };
		});
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
					debug(`[signal] command reply sent: ${cmd}`);
				} else if (isLoggingEnabled()) {
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

		// Get the current model info for the "no query" case
		const currentModel = ctx.model
			? { name: ctx.model.name, id: ctx.model.id, provider: ctx.model.provider }
			: null;

		const models = getModelList(ctx);
		const matches = fuzzyMatchModelsLocal(query, models);

		// Call the pure function to get the response message
		const modelResponse = commands.buildModelResponse({
			query,
			currentModel,
			models,
			matches,
		});

		// Handle the different response types
		switch (modelResponse.type) {
			case "current":
				reply(modelResponse.message);
				return;
			case "no_models":
				reply(modelResponse.message);
				return;
			case "exact_match":
				// Exact match case handled separately below
				break;
			case "no_close_match":
				reply(modelResponse.message);
				return;
			case "single_match": {
				// Find the actual model entry for switching
				const match = models.find((m) => m.label === modelResponse.label);
				if (match) {
					const ok = await pi.setModel(match.model as any);
					reply(ok ? `Switched to ${match.label}` : `Failed to switch to ${match.label}. Check API key configuration.`);
				}
				return;
			}
			case "multiple_matches":
				reply(modelResponse.message);
				return;
		}

		// Handle exact model ID match (bypasses fuzzy search)
		const qLower = query.toLowerCase().trim();
		for (const entry of models) {
			const entryObj = entry.model as { id?: string };
			if (entryObj.id && entryObj.id.toLowerCase() === qLower) {
				const ok = await pi.setModel(entry.model as any);
				reply(ok ? `Switched to ${entry.label}` : `Failed to switch to ${entry.label}. Check API key configuration.`);
				return;
			}
		}
	}

	async function handleAbortCommand(
		ctx: ExtensionContext,
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		// Call pure function for the response message
		const abortResponse = commands.buildAbortResponse(ctx.isIdle());

		if (abortResponse.message.includes("idle")) {
			reply(abortResponse.message);
			return;
		}

		// Side effect: abort the agent
		ctx.abort();
		reply(abortResponse.message);

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

		// Call pure function for the response message
		const clearMessage = commands.buildClearMessage(ctx.isIdle());
		reply(clearMessage);

		try {
			if (typeof (ctx as any).newSession === "function") {
				await (ctx as any).newSession({
					withSession: async (_newCtx: unknown) => {
						debug("[signal] new session started via /clear");
					},
				});
			} else {
				debug("[signal] newSession not available on context");
			}
		} catch (err) {
			if (isLoggingEnabled()) console.error("[signal] /clear error:", err);
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
			const usage = ctx?.getContextUsage?.();
			const percent = usage?.percent ?? undefined;

			// Call pure function for the response
			const statsResponse = commands.buildStatsResponse({
				statsMode,
				percent,
			});
			reply(statsResponse.message);
			return;
		}

		if (arg === "short" || arg === "full" || arg === "off") {
			statsMode = arg;
			reply(`Stats mode set to: ${arg}`);
		} else {
			reply(`Invalid stats mode "${arg}". Use: short, full, off`);
		}
	}

	/** Stop typing indicators for all tracked numbers (no-op if none active). */
	function stopTypingIndicators(): void {
		stopTypingForAll();
		for (const number of activeTyping) {
			void sendTypingIndicator(number, "stopped");
		}
		activeTyping.clear();
	}

	/** Clear heartbeat timers for all tracked numbers (doesn't send stop). */
	function stopTypingForAll(): void {
		for (const timer of typingHeartbeats.values()) {
			clearInterval(timer);
		}
		typingHeartbeats.clear();
	}

	/** Stop heartbeat timer for a single recipient (idempotent). */
	function stopTypingHeartbeat(number: string): void {
		const timer = typingHeartbeats.get(number);
		if (timer) {
			clearInterval(timer);
			typingHeartbeats.delete(number);
		}
	}

	/** Start a typing heartbeat: resend "started" every 10s while the agent works. */
	function startTypingHeartbeat(number: string): void {
		typingHeartbeats.set(
			number,
			setInterval(() => {
				sendTypingIndicator(number, "started").catch(() => {});
			}, 10_000),
		);
	}

	async function forwardToAgent(parsed: {
		sender: string;
		number: string;
		body: string;
		timestamp: number;
		attachments: string[];
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
					if (!ok && isLoggingEnabled()) console.error("[signal] failed to send 👀 reaction");
				},
			);
		}

		// Show the typing indicator while the agent works on this response.
		if (/^\+\d{7,15}$/.test(parsed.number)) {
			sendTypingIndicator(parsed.number, "started").then((ok) => {
				if (ok) {
					activeTyping.add(parsed.number);
					startTypingHeartbeat(parsed.number);
				} else if (isLoggingEnabled()) {
					console.error(`[signal] failed to send typing indicator to ${parsed.number}`);
				}
			});
		}

		// Format message text, including attachment paths for the LLM to see
		const formatted = formatIncomingMessage(parsed);
		pi.sendUserMessage(formatted, { deliverAs: "followUp" });
	}

	async function handleHelpCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		// Call pure function for the help response
		const helpResponse = commands.buildHelpResponse();
		reply(helpResponse.message);
	}

	async function handleStatusCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		const ctx = extCtx;
		const model = ctx?.model;

		// Gather session info from sessionManager
		let sessionName: string | undefined;
		let sessionFile: string | undefined;
		let sessionId: string | undefined;
		if (ctx?.sessionManager) {
			sessionName = ctx.sessionManager.getSessionName?.();
			sessionFile = ctx.sessionManager.getSessionFile?.();
			sessionId = ctx.sessionManager.getSessionId?.();
		}
		// Fallback to pi.getSessionName
		if (!sessionName) {
			try {
				sessionName = pi.getSessionName?.();
			} catch {}
		}

		// Gather context usage stats
		const usage = ctx?.getContextUsage?.();

		// Call the pure function to build the status response
		const statusResponse = commands.buildStatusResponse({
			ctxTokens: usage?.tokens ?? null,
			ctxWindow: usage?.contextWindow ?? null,
			ctxPercent: usage?.percent ?? null,
			modelName: model?.name || model?.id || "unknown",
			modelProvider: model?.provider,
			account: PI_SIGNAL_ACCOUNT,
			isPrimary: PI_SIGNAL_PRIMARY,
			wsConnected,
			statsMode,
			paused,
			sessionName,
			sessionId,
			sessionFile,
		});

		reply(statusResponse.message);
	}

	async function handleResendCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		// Call pure function for the response
		const resendResponse = commands.buildResendResponse(lastAgentReply);
		reply(resendResponse.message);
	}

	async function handleWhoamiCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		const ctx = extCtx;
		const model = ctx?.model;
		let sessionName: string | undefined;
		try {
			sessionName = pi.getSessionName?.();
		} catch {
			sessionName = undefined;
		}

		// Call the pure function
		const whoamiResponse = commands.buildWhoamiResponse({
			modelName: model?.name || model?.id || "unknown",
			modelProvider: model?.provider,
			cwd: ctx?.cwd,
			sessionName,
			account: PI_SIGNAL_ACCOUNT,
			isPrimary: PI_SIGNAL_PRIMARY,
		});

		reply(whoamiResponse.message);
	}

	async function handlePauseCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		// Call pure function to determine the response
		const pauseResult = commands.buildPauseResponse(paused);

		if (pauseResult.paused && !paused) {
			// Actually transition to paused state
			paused = true;
		}

		reply(pauseResult.message);
	}

	async function handleResumeCommand(
		parsed: { sender: string; number: string; body: string; timestamp: number },
		reply: (text: string) => void,
	): Promise<void> {
		// Call pure function to determine the response
		const resumeResult = commands.buildResumeResponse(paused);

		if (resumeResult.resumed) {
			// Actually transition to resumed state
			paused = false;
		}

		reply(resumeResult.message);
	}

	function injectMessage(parsed: {
		sender: string;
		number: string;
		body: string;
		timestamp: number;
		attachments: string[];
	}) {
		debug(`[signal] injectMessage: number=${parsed.number}, account=${PI_SIGNAL_ACCOUNT}, paused=${paused}`);
		// Note-to-Self messages: only process from own account
		if (parsed.number === PI_SIGNAL_ACCOUNT) {
			const body = parsed.body.trim();
			if (body.startsWith("/")) {
				const parts = body.slice(1).split(/\s+/);
				const cmd = parts[0].toLowerCase();
				const args = parts.slice(1);
				handleCommand(parsed, cmd, args).catch((err) => {
					if (isLoggingEnabled()) console.error(`[signal] command error (${cmd}):`, err);
				});
			} else if (!paused) {
				forwardToAgent(parsed);
			}
			return;
		}

		// Messages from others: check allowlist
		if (!isAllowedNumberLocal(parsed.number)) {
			debug(
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
				if (isLoggingEnabled()) console.error(`[signal] command error (${cmd}):`, err);
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
			debug(
				"[signal] PI_SIGNAL_PRIMARY is not set — skipping WebSocket listener.",
			);
			return;
		}

		if (!PI_SIGNAL_ACCOUNT) {
			if (isLoggingEnabled()) console.warn("[signal] PI_SIGNAL_ACCOUNT is not set — cannot start WebSocket listener.");
			return;
		}

		doWebSocketConnect();
	}

	function doWebSocketConnect() {
		cleanupWebSocket();

		const baseUrl = new URL(SIGNAL_DAEMON_URL);
		const wsPath = `/v1/receive/${encodeURIComponent(PI_SIGNAL_ACCOUNT)}?timeout=30`;

		const isHttps = baseUrl.protocol === "https:";

		const protocol = isHttps ? "wss://" : "ws://";
		const wsUrl = `${protocol}${baseUrl.hostname}:${baseUrl.port || 80}${wsPath}`;

		debug(`[signal] connecting WebSocket to ${wsUrl}`);

		try {
			const ws = new WebSocket(wsUrl);

			ws.onopen = () => {
				debug("[signal] WebSocket connected — listening for incoming messages");
				wsConnected = true;
				wsReconnectDelay = WS_RETRY_DELAY_INITIAL;
			};

			ws.onmessage = async (event: MessageEvent) => {
				const data = typeof event.data === "string" ? event.data : event.data.toString("utf8");
				if (!data.trim()) return;

				debug(`[signal] WS raw (first 200): ${data.slice(0, 200)}`);
				const parsed = await parseEnvelope(data);
				if (parsed) {
					debug(`[signal] parsed -> from ${parsed.number}: "${parsed.body}", attachments=${parsed.attachments.length}`);
					injectMessage(parsed);
				} else {
					debug(`[signal] parseEnvelope returned null — message DROPPED`);
				}
			};

			ws.onerror = (err: Event) => {
				if (isLoggingEnabled()) console.error("[signal] WebSocket error:", err);
				wsConnected = false;
			};

			ws.onclose = (event: CloseEvent) => {
				debug(`[signal] WebSocket closed (code: ${event.code})`);
				wsConnected = false;
				scheduleWsReconnect();
			};

			// Store the WebSocket for cleanup
			(ws as any).__cleanup = ws.close.bind(ws);
			(globalThis as any).__signalWs = ws;
		} catch (err) {
			if (isLoggingEnabled()) console.error(`[signal] WebSocket connection error: ${(err as Error).message}`);
			wsConnected = false;
			scheduleWsReconnect();
		}
	}

	function scheduleWsReconnect() {
		if (wsReconnectTimer) return;

		const delay = wsReconnectDelay;
		debug(`[signal] reconnecting WebSocket in ${delay}ms`);

		wsReconnectTimer = setTimeout(() => {
			wsReconnectTimer = null;
			wsReconnectDelay = Math.min(
				wsReconnectDelay * 2,
				WS_RETRY_DELAY_MAX,
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
					debug(`[signal] resolved account UUID: ${uuid}`);
					return uuid;
				}
			}
		}

		debug("[signal] account not found in contacts — using phone number");
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

		// For Note-to-Self replies, use resolved UUID for grey (synced) rendering.
		// For external replies, send to the original sender's number.
		const isSelf = _recipient === PI_SIGNAL_ACCOUNT;
		const targetId = isSelf && resolvedAccountId ? resolvedAccountId : _recipient;
		const ok = await sendMessage(targetId, text);
		return ok;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────

	/** Periodic cleanup of old attachment files (every 6 hours). */
	let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

	function startAttachmentCleanup(): void {
		const scheduleNext = () => {
			cleanupTimer = setTimeout(() => {
				attachments.cleanupAttachments();
				scheduleNext();
			}, 6 * 60 * 60 * 1000);
		};
		// Initial cleanup after 30 seconds
		cleanupTimer = setTimeout(() => {
			attachments.cleanupAttachments();
			scheduleNext();
		}, 30_000);
	}

	function stopAttachmentCleanup(): void {
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
			cleanupTimer = null;
		}
	}

	pi.on("session_start", async (_event: unknown, ctx: unknown) => {
		extCtx = ctx as ExtensionContext | null;

		resolvedAccountId = await resolveAccountId();

		startWebSocketListener();
		startAttachmentCleanup();
	});

	// Auto-send agent responses back to Signal, with stats footer
	pi.on("agent_end", async (event: unknown, ctx: unknown) => {
		debug(`[signal] agent_end: currentSignalSender=${currentSignalSender ? JSON.stringify(currentSignalSender) : "null"}`);
		// The agent finished this turn — clear any typing indicators.
		stopTypingIndicators();
		if (!currentSignalSender) {
			debug("[signal] agent_end: no currentSignalSender, skipping");
			return;
		}

		const sender = currentSignalSender;
		currentSignalSender = null;

		try {
			const messages =
				(event as { messages?: Array<{ role?: string; content?: unknown }> })
					.messages ?? [];

			// Pure extraction lives in extractReplyText() (utils.ts).
			let fullText = extractReplyText(messages);
			if (!fullText) return;

			if (statsMode !== "off") {
				const statsFooter = buildStatsFooterLocal(ctx as ExtensionContext | null);
				if (statsFooter) {
					fullText += statsFooter;
				}
			}

			lastAgentReply = fullText;

			const ok = await sendToSignal(sender.number, fullText);
			if (ok) {
				debug(`[signal] auto-reply sent to ${sender.number}`);
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
				if (isLoggingEnabled()) console.error(`[signal] failed to auto-reply to ${sender.number}`);
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
			if (isLoggingEnabled()) console.error("[signal] auto-reply error:", err);
		}
	});

	pi.on("model_select", async (event: unknown) => {
		const ev = event as { model?: { name?: string; id?: string } };
		if (ev?.model) {
			debug(
				`[signal] model switched to ${ev.model.name || ev.model.id || "unknown"}`,
			);
		}
	});

	pi.on("session_shutdown", async () => {
		stopTypingIndicators();
		cleanupWebSocket();
		stopAttachmentCleanup();
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
			const cleaned = normalizePhoneNumber(params.recipient);
			if (!isValidE164(cleaned)) {
				throw new Error(
					`Invalid recipient "${params.recipient}". Must be E.164 format, e.g. +1234567890.`,
				);
			}

			if (!isAllowedNumberLocal(cleaned)) {
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

			// Note: we deliberately do NOT clear the typing indicator here.
			// The agent_end handler cleans up all typing indicators after the
			// turn completes. Clearing them here races with the propagation of
			// the started indicator through the Signal network — the client
			// may never see it if it's stopped too quickly.

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
					return { name: sanitizeContactNameLocal(name), number };
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

			const matches = fuzzyMatchModelsLocal(query, models);
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
			const cleaned = normalizePhoneNumber(rawNum);
			if (!isValidE164(cleaned)) {
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

			if (!isAllowedNumberLocal(cleaned)) {
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
