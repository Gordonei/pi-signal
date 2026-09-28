/**
 * Tests for the pure command logic in commands.ts.
 *
 * These functions take only data inputs and return plain output — no side effects,
 * no pi runtime dependency. The signal.ts handlers call these and apply formatting /
 * trigger side effects (switching models, aborting, sending to Signal).
 */

import {
	formatTokens,
	buildStatusResponse,
	buildWhoamiResponse,
	buildStatsResponse,
	buildPauseResponse,
	buildResumeResponse,
	buildResendResponse,
	buildAbortResponse,
	buildClearMessage,
	buildHelpResponse,
	buildModelResponse,
} from "../../extensions/commands";

describe("formatTokens", () => {
	it("returns the number as string when below 1000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(100)).toBe("100");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats thousands with K suffix", () => {
		expect(formatTokens(1000)).toBe("1.0K");
		expect(formatTokens(1500)).toBe("1.5K");
		expect(formatTokens(125300)).toBe("125.3K");
	});
});

describe("buildStatusResponse", () => {
	it("includes all core fields", () => {
		const result = buildStatusResponse({
			ctxTokens: 5000,
			ctxWindow: 200000,
			ctxPercent: 2.5,
			modelName: "claude-sonnet-4",
			modelProvider: "anthropic",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: false,
			isBusy: false,
		});

		expect(result.message).toContain("✅ pi is up and receiving Signal.");
		expect(result.message).toContain("Account: +15551234567");
		expect(result.message).toContain("Primary: yes");
		expect(result.message).toContain("REST API: connected");
		expect(result.message).toContain("Model: claude-sonnet-4 (anthropic)");
		expect(result.message).toContain("Context: 5.0K / 200.0K (3%)");
		expect(result.message).toContain("Stats: short");
		expect(result.message).toContain("State: active");
	});

	it("shows disconnected REST API when wsConnected is false", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "gpt-4o",
			account: "+15551234567",
			isPrimary: false,
			wsConnected: false,
			statsMode: "full",
			paused: false,
			isBusy: false,
		});

		expect(result.message).toContain("REST API: disconnected");
		expect(result.message).toContain("Primary: no");
	});

	it("includes session info when available", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "claude-sonnet-4",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: false,
			isBusy: false,
			sessionName: "my-feature-work",
			sessionId: "abc123",
			sessionFile: "/test/session.jsonl",
		});

		expect(result.message).toContain("Session: my-feature-work");
		expect(result.message).toContain("Session ID: abc123");
		expect(result.message).toContain("Session file: /test/session.jsonl");
	});

	it("omits session lines when not provided", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "claude-sonnet-4",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: false,
			isBusy: false,
		});

		expect(result.message).toContain("Session: (unnamed)");
		expect(result.message).not.toContain("Session ID:");
		expect(result.message).not.toContain("Session file:");
	});

	it("shows paused state when paused is true", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "claude-sonnet-4",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: true,
			isBusy: false,
		});

		expect(result.message).toContain("⏸ paused (send /resume)");
	});

	it("shows context without percentage when percent is null", () => {
		const result = buildStatusResponse({
			ctxTokens: 15000,
			ctxWindow: 200000,
			ctxPercent: null,
			modelName: "claude-sonnet-4",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: false,
			isBusy: false,
		});

		expect(result.message).toMatch(/Context: 15\.0K \/ 200\.0K \(—\)*/);
	});

	it("shows context tokens only when window is missing", () => {
		const result = buildStatusResponse({
			ctxTokens: 8500,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "claude-sonnet-4",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: false,
			isBusy: false,
		});

		expect(result.message).toContain("Context: 8.5K tokens");
		expect(result.message).not.toContain("/");
	});

	it("omits context line when tokens are null", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: 200000,
			ctxPercent: null,
			modelName: "claude-sonnet-4",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: false,
			isBusy: false,
		});

		expect(result.message).not.toContain("Context:");
	});

	it("shows (not set) when account is empty", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "gpt-4o",
			account: "",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: false,
			isBusy: false,
		});

		expect(result.message).toContain("Account: (not set)");
	});

		it("rounds percentage correctly", () => {
			const result = buildStatusResponse({
				ctxTokens: 100000,
				ctxWindow: 200000,
				ctxPercent: 50.4,
				modelName: "claude-sonnet-4",
				account: "+15551234567",
				isPrimary: true,
				wsConnected: true,
				statsMode: "short",
				paused: false,
				isBusy: false,
			});

			expect(result.message).toContain("50%");
		});

		it("shows 'State: active' when paused is false", () => {
			const result = buildStatusResponse({
				ctxTokens: null,
				ctxWindow: null,
				ctxPercent: null,
				modelName: "claude-sonnet-4",
				account: "+15551234567",
				isPrimary: true,
				wsConnected: true,
				statsMode: "short",
				paused: false,
				isBusy: false,
			});

			expect(result.message).toContain("State: active");
			expect(result.message).not.toContain("paused");
		});

		it("shows model without provider suffix when provider is missing", () => {
			const result = buildStatusResponse({
				ctxTokens: null,
				ctxWindow: null,
				ctxPercent: null,
				modelName: "my-custom-model",
				account: "+15551234567",
				isPrimary: true,
				wsConnected: true,
				statsMode: "short",
				paused: false,
				isBusy: false,
			});

			expect(result.message).toContain("Model: my-custom-model");
		});

		it("maintains correct field order: core → session → context → stats → state → agent", () => {
			const result = buildStatusResponse({
				ctxTokens: 75000,
				ctxWindow: 200000,
				ctxPercent: 37.5,
				modelName: "claude-sonnet-4",
				modelProvider: "anthropic",
				account: "+15551234567",
				isPrimary: true,
				wsConnected: true,
				statsMode: "full",
				paused: false,
				isBusy: false,
				sessionName: "full-test-session",
				sessionId: "test-uuid-123",
				sessionFile: "/test/path/session.jsonl",
			});

			const lines = result.message.split("\n");

			const accountIdx = lines.findIndex((l) => l.startsWith("Account:"));
			const modelIdx = lines.findIndex((l) => l.startsWith("Model:"));
			const sessionLineIdx = lines.findIndex((l) => l.startsWith("Session:"));
			const contextLineIdx = lines.findIndex((l) => l.startsWith("Context:"));
			const statsIdx = lines.findIndex((l) => l.startsWith("Stats:"));
			const stateIdx = lines.findIndex((l) => l.startsWith("State:"));
			const agentIdx = lines.findIndex((l) => l.startsWith("Agent:"));

			expect(accountIdx).toBeLessThan(modelIdx);
			expect(modelIdx).toBeLessThan(sessionLineIdx);
			expect(sessionLineIdx).toBeLessThan(contextLineIdx);
			expect(contextLineIdx).toBeLessThan(statsIdx);
			expect(statsIdx).toBeLessThan(stateIdx);
			expect(stateIdx).toBeLessThan(agentIdx);
		});
});

describe("buildStatusResponse - isBusy", () => {
	it("shows agent idle when isBusy is false", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "gpt-4o",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: false,
			isBusy: false,
		});

		expect(result.message).toContain("Agent: idle");
	});

	it("shows agent busy when isBusy is true", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "claude-sonnet-4",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: false,
			isBusy: true,
		});

		expect(result.message).toContain("Agent: ⚙️ busy");
	});

	it("shows busy even when paused", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "gpt-4o",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: true,
			isBusy: true,
		});

		expect(result.message).toContain("⏸ paused (send /resume)");
		expect(result.message).toContain("Agent: ⚙️ busy");
	});

	it("shows idle and paused correctly together", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "gpt-4o",
			account: "+15551234567",
			isPrimary: true,
			wsConnected: true,
			statsMode: "short",
			paused: true,
			isBusy: false,
		});

		expect(result.message).toContain("⏸ paused (send /resume)");
		expect(result.message).toContain("Agent: idle");
	});

	it("includes agent line in minimal status", () => {
		const result = buildStatusResponse({
			ctxTokens: null,
			ctxWindow: null,
			ctxPercent: null,
			modelName: "test-model",
			account: "",
			isPrimary: false,
			wsConnected: false,
			statsMode: "off",
			paused: false,
			isBusy: false,
		});

		expect(result.message).toContain("Agent: idle");
	});
});

describe("buildWhoamiResponse", () => {
	it("includes all whoami fields", () => {
		const result = buildWhoamiResponse({
			modelName: "claude-sonnet-4",
			modelProvider: "anthropic",
			cwd: "/test/workspace",
			sessionName: "my-session",
			account: "+15551234567",
			isPrimary: true,
		});

		expect(result.message).toContain("Model: claude-sonnet-4 (anthropic)");
		expect(result.message).toContain("Directory: /test/workspace");
		expect(result.message).toContain("Session: my-session");
		expect(result.message).toContain("Account: +15551234567");
		expect(result.message).toContain("Primary: yes");
	});

	it("shows (unnamed) when sessionName is undefined", () => {
		const result = buildWhoamiResponse({
			modelName: "gpt-4o",
			cwd: "/test",
			sessionName: undefined,
			account: "+15551234567",
			isPrimary: true,
		});

		expect(result.message).toContain("Session: (unnamed)");
		expect(result.sessionName).toBe("(unnamed)");
	});

	it("shows unknown when cwd is empty", () => {
		const result = buildWhoamiResponse({
			modelName: "gpt-4o",
			cwd: "",
			sessionName: "test",
			account: "+15551234567",
			isPrimary: true,
		});

		expect(result.message).toContain("Directory: unknown");
		expect(result.cwd).toBe("unknown");
	});
});

describe("buildStatsResponse", () => {
	it("shows current percent when available", () => {
		const result = buildStatsResponse({
			statsMode: "short",
			percent: 7.71,
		});

		expect(result.message).toContain("Stats mode: short");
		expect(result.message).toContain("8% context used");
		expect(result.currentPercent).toBe(7.71);
		expect(result.mode).toBe("short");
	});

	it("shows usage instructions when no percent", () => {
		const result = buildStatsResponse({
			statsMode: "full",
		});

		expect(result.message).toContain("Stats mode: full");
		expect(result.message).toContain("/stats short");
		expect(result.message).toContain("/stats full");
		expect(result.message).toContain("/stats off");
		expect(result.currentPercent).toBeUndefined();
	});

	it("handles zero percent", () => {
		const result = buildStatsResponse({
			statsMode: "off",
			percent: 0,
		});

		expect(result.message).toContain("Stats mode: off");
		expect(result.message).toContain("0% context used");
	});
});

describe("buildPauseResponse", () => {
	it("returns already paused when already paused", () => {
		const result = buildPauseResponse(true);

		expect(result.paused).toBe(true);
		expect(result.message).toBe("Already paused. Send /resume to re-enable.");
	});

	it("returns paused new state when not paused", () => {
		const result = buildPauseResponse(false);

		expect(result.paused).toBe(true);
		expect(result.message).toContain("⏸ Paused.");
	});
});

describe("buildResumeResponse", () => {
	it("returns not paused when already not paused", () => {
		const result = buildResumeResponse(false);

		expect(result.resumed).toBe(false);
		expect(result.message).toBe("Not paused — messages are already being processed.");
	});

	it("returns resumed new state when paused", () => {
		const result = buildResumeResponse(true);

		expect(result.resumed).toBe(true);
		expect(result.message).toContain("▶️ Resumed.");
	});
});

describe("buildResendResponse", () => {
	it("shows nothing to resend when lastReply is null", () => {
		const result = buildResendResponse(null);
		expect(result.message).toBe("Nothing to resend yet.");
	});

	it("returns the last reply when available", () => {
		const reply = "Hello, how can I help?";
		const result = buildResendResponse(reply);
		expect(result.message).toBe(reply);
	});
});

describe("buildAbortResponse", () => {
	it("shows idle message when agent is idle", () => {
		const result = buildAbortResponse(true);
		expect(result.message).toBe("Nothing to abort — the agent is idle.");
	});

	it("shows aborted message when agent is not idle", () => {
		const result = buildAbortResponse(false);
		expect(result.message).toBe("⏹ Response aborted.");
	});
});

describe("buildClearMessage", () => {
	it("always returns the same message", () => {
		expect(buildClearMessage(true)).toBe("🧹 Starting new session…");
		expect(buildClearMessage(false)).toBe("🧹 Starting new session…");
	});
});

describe("buildHelpResponse", () => {
	it("lists all commands", () => {
		const result = buildHelpResponse();
		expect(result.message).toContain("/model");
		expect(result.message).toContain("/abort");
		expect(result.message).toContain("/clear");
		expect(result.message).toContain("/stats");
		expect(result.message).toContain("/status");
		expect(result.message).toContain("/whoami");
		expect(result.message).toContain("/resend");
		expect(result.message).toContain("/pause");
		expect(result.message).toContain("/resume");
		expect(result.message).toContain("/help");
	});
});

describe("buildModelResponse", () => {
	const mockModels = [
		{ label: "claude-sonnet-4 (anthropic/claude-sonnet-4)", model: { id: "claude-sonnet-4" } },
		{ label: "gpt-4o (openai/gpt-4o)", model: { id: "gpt-4o" } },
	];

	it("shows current model when query is empty", () => {
		const result = buildModelResponse({
			query: "",
			currentModel: { name: "claude-sonnet-4", id: "claude-sonnet-4", provider: "anthropic" },
			models: mockModels,
			matches: [],
		});

		expect(result.type).toBe("current");
		expect(result.message).toContain("Current model: claude-sonnet-4 (anthropic)");
	});

	it("shows no models when list is empty", () => {
		const result = buildModelResponse({
			query: "claude",
			currentModel: null,
			models: [],
			matches: [],
		});

		expect(result.type).toBe("no_models");
		expect(result.message).toBe("No models available. Configure a provider first.");
	});

	it("shows no close match when no good results", () => {
		const result = buildModelResponse({
			query: "xyzzy123",
			currentModel: null,
			models: mockModels,
			matches: [
				{ label: "claude-sonnet-4 (anthropic/claude-sonnet-4)", score: 0.7 },
				{ label: "gpt-4o (openai/gpt-4o)", score: 0.8 },
			],
		});

		expect(result.type).toBe("no_close_match");
		expect(result.message).toContain("No close match for \"xyzzy123\"");
	});

	it("returns single match result when one good match with low score", () => {
		const result = buildModelResponse({
			query: "claude",
			currentModel: null,
			models: mockModels,
			matches: [
				{ label: "claude-sonnet-4 (anthropic/claude-sonnet-4)", score: 0.07 },
				{ label: "gpt-4o (openai/gpt-4o)", score: 0.7 },
			],
		});

		expect(result.type).toBe("single_match");
		expect(result.label).toBe("claude-sonnet-4 (anthropic/claude-sonnet-4)");
	});

	it("returns multiple matches when several good options", () => {
		const result = buildModelResponse({
			query: "gpt",
			currentModel: null,
			models: mockModels,
			matches: [
				{ label: "gpt-4o (openai/gpt-4o)", score: 0.1 },
				{ label: "claude-sonnet-4 (anthropic/claude-sonnet-4)", score: 0.3 },
			],
		});

		expect(result.type).toBe("multiple_matches");
		expect(result.message).toContain("Multiple matches");
	});
});
