// @ts-nocheck
// Pure command logic for Signal extension commands.
// These functions take only data inputs and return plain output — no side effects.
// The signal.ts handlers wire these up to the pi runtime.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FuzzyMatchResult } from "./utils.js";

// ── Shared Types ──────────────────────────────────────────────────────

export interface CommandReply {
	message: string;
}

export interface PauseResult extends CommandReply {
	/** Whether the new state is paused. */
	paused: boolean;
}

export interface ResumeResult extends CommandReply {
	/** Whether the new state is not paused. */
	resumed: boolean;
}

export interface SwitchModelResult extends CommandReply {
	/** Whether the switch succeeded. */
	succeeded: boolean;
}

export interface ModelResponse {
	type: "current" | "no_models" | "exact_match" | "no_close_match" | "single_match" | "multiple_matches";
	message: string;
	label?: string;
}

export interface StatsResponse {
	message: string;
	mode: "short" | "full" | "off";
	/** Current context usage percentage, or null if unavailable. */
	currentPercent?: number | null;
}

export interface StatusResponse extends CommandReply {
	/** Session name, or undefined. */
	sessionName?: string;
	/** Session ID, or undefined. */
	sessionId?: string;
	/** Session file path, or undefined. */
	sessionFile?: string;
	/** Current context tokens, or null. */
	ctxTokens: number | null;
	/** Context window size, or null. */
	ctxWindow: number | null;
	/** Context usage percentage, or null. */
	ctxPercent: number | null;
}

export interface WhoamiResponse extends CommandReply {
	sessionName: string;
	cwd: string;
}

// ── Helpers (pure) ────────────────────────────────────────────────────

/**
 * Format a token count for display. Values >= 1000 are shown as "X.XK".
 */
export function formatTokens(n: number): string {
	if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
	return String(n);
}

/**
 * Build the status message for /status.
 */
export function buildStatusResponse(opts: {
	ctxTokens: number | null;
	ctxWindow: number | null;
	ctxPercent: number | null;
	modelName: string;
	modelProvider?: string;
	account: string;
	isPrimary: boolean;
	wsConnected: boolean;
	statsMode: string;
	paused: boolean;
	isBusy: boolean;
	sessionName?: string;
	sessionId?: string;
	sessionFile?: string;
}): CommandReply {
	const {
		modelName,
		modelProvider,
		account,
		isPrimary,
		wsConnected,
		statsMode,
		paused,
		isBusy,
		sessionName,
		sessionId,
		sessionFile,
		ctxTokens,
		ctxWindow,
		ctxPercent,
	} = opts;

	const providerSuffix = modelProvider ? ` (${modelProvider})` : "";

	const lines: string[] = [
		"✅ pi is up and receiving Signal.",
		`Account: ${account || "(not set)"}`,
		`Primary: ${isPrimary ? "yes" : "no"}`,
		`REST API: ${wsConnected ? "connected" : "disconnected"}`,
		`Model: ${modelName}${providerSuffix}`,
	];

	const displaySessionName = sessionName || "(unnamed)";
	lines.push(`Session: ${displaySessionName}`);
	if (sessionId && sessionName) {
		lines.push(`Session ID: ${sessionId}`);
	}
	if (sessionFile && sessionName) {
		lines.push(`Session file: ${sessionFile}`);
	}

	if (ctxTokens != null && ctxWindow) {
		const tokensStr = formatTokens(ctxTokens);
		const pctStr = ctxPercent != null ? `${Math.round(ctxPercent)}%` : "—";
		lines.push(`Context: ${tokensStr} / ${formatTokens(ctxWindow)} (${pctStr})`);
	} else if (ctxTokens != null) {
		lines.push(`Context: ${formatTokens(ctxTokens)} tokens`);
	}

	lines.push(`Stats: ${statsMode}`);
	lines.push(`State: ${paused ? "⏸ paused (send /resume)" : "active"}`);
	lines.push(`Agent: ${isBusy ? "⚙️ busy" : "idle"}`);

	return { message: lines.join("\n") };
}

/**
 * Build the whoami response.
 */
export function buildWhoamiResponse(opts: {
	modelName: string;
	modelProvider?: string;
	cwd: string;
	sessionName: string;
	account: string;
	isPrimary: boolean;
}): WhoamiResponse {
	const providerSuffix = opts.modelProvider ? ` (${opts.modelProvider})` : "";
	const message = [
		`Model: ${opts.modelName}${providerSuffix}`,
		`Directory: ${opts.cwd || "unknown"}`,
		`Session: ${opts.sessionName || "(unnamed)"}`,
		`Account: ${opts.account || "(not set)"}`,
		`Primary: ${opts.isPrimary ? "yes" : "no"}`,
	].join("\n");

	return { message, sessionName: opts.sessionName || "(unnamed)", cwd: opts.cwd || "unknown" };
}

/**
 * Build the stats response.
 */
export function buildStatsResponse(opts: {
	statsMode: "short" | "full" | "off";
	percent?: number | null;
}): StatsResponse {
	const { statsMode, percent } = opts;

	if (!percent && percent !== 0) {
		return {
			message: `Stats mode: ${statsMode}\n\nUsage:\n/stats short — enable short stats (default)\n/stats full  — enable full stats\n/stats off   — disable stats`,
			mode: statsMode,
			currentPercent: percent,
		};
	}

	const usageLine = ` · ${Math.round(percent!)}% context used`;
	return {
		message: `Stats mode: ${statsMode}${usageLine}\n\nUsage:\n/stats short — enable short stats (default)\n/stats full  — enable full stats\n/stats off   — disable stats`,
		mode: statsMode,
		currentPercent: percent,
	};
}

/**
 * Build the pause response.
 */
export function buildPauseResponse(paused: boolean): PauseResult {
	if (paused) {
		return {
			message: "Already paused. Send /resume to re-enable.",
			paused: true,
		};
	}
	return {
		message: "⏸ Paused. Incoming messages will be ignored until you send /resume. Commands still work.",
		paused: true,
	};
}

/**
 * Build the resume response.
 */
export function buildResumeResponse(paused: boolean): ResumeResult {
	if (!paused) {
		return {
			message: "Not paused — messages are already being processed.",
			resumed: false,
		};
	}
	return {
		message: "▶️ Resumed. Messages will be processed again.",
		resumed: true,
	};
}

/**
 * Build the resend response.
 */
export function buildResendResponse(lastReply: string | null): CommandReply {
	if (!lastReply) {
		return { message: "Nothing to resend yet." };
	}
	return { message: lastReply };
}

/**
 * Build the abort response.
 */
export function buildAbortResponse(isIdle: boolean): CommandReply {
	if (isIdle) {
		return { message: "Nothing to abort — the agent is idle." };
	}
	return { message: "⏹ Response aborted." };
}

/**
 * Build the clear response message.
 */
export function buildClearMessage(): string {
	return "🧹 Starting new session…";
}

/**
 * Build the help response.
 */
export function buildHelpResponse(): CommandReply {
	return {
		message:
			"Available commands:\n" +
			"/model <name> — switch model (fuzzy match)\n" +
			"/abort — stop current generation\n" +
			"/clear — start new session\n" +
			"/stats [short|full|off] — toggle usage stats\n" +
			"/status — show session, model, connection & token usage\n" +
			"/whoami — show model, directory, and session\n" +
			"/resend — resend the last reply\n" +
			"/pause — stop processing incoming messages\n" +
			"/resume — resume processing\n" +
			"/help — show this help",
	};
}

/**
 * Build the model response based on query, current model, and available models.
 */
export function buildModelResponse(opts: {
	query: string;
	currentModel: { name?: string; id?: string; provider?: string } | null;
	models: Array<{ label: string; model: unknown }>;
	matches: FuzzyMatchResult[];
}): ModelResponse {
	const { query, currentModel, models, matches } = opts;

	if (!query) {
		const name = currentModel?.name || currentModel?.id || "unknown";
		const provider = currentModel?.provider || "?";
		return {
			type: "current",
			message: `Current model: ${name} (${provider})\n\nUsage: /model <partial name>\nExamples: /model claude, /model gpt, /model sonnet`,
		};
	}

	if (models.length === 0) {
		return {
			type: "no_models",
			message: "No models available. Configure a provider first.",
		};
	}

	const good = matches.filter((m) => m.score < 0.5);

	if (good.length === 0) {
		const closest = matches.slice(0, 5);
		const lines = closest.map((m, i) => `${i + 1}. ${m.label}`);
		return {
			type: "no_close_match",
			message: `No close match for "${query}". Did you mean:\n${lines.join("\n")}`,
		};
	}

	const best = good[0];
	if (good.length === 1 && best.score < 0.15) {
		return {
			type: "single_match",
			message: best.label,
			label: best.label,
		};
	}

	const show = good.slice(0, 10);
	const lines = show.map((m, i) => `${i + 1}. ${m.label}`);
	return {
		type: "multiple_matches",
		message: `Multiple matches for "${query}":\n${lines.join("\n")}\n\nSend a more specific query.`,
	};
}
