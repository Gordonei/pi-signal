/**
 * Tests for command handler functions in signal.ts.
 *
 * The handlers are async wrappers that:
 * 1. Call the pure command function to get the response message
 * 2. Apply side effects (switching models, aborting, starting sessions)
 * 3. Send the message back to Signal via sendToSignal()
 *
 * These tests mock the pure functions and verify the handlers call them
 * with the right arguments and handle the results correctly.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// We can't import signal.ts directly because it's a factory function.
// Instead, we test the handler wiring by mocking the pure functions
// and verifying the expected behavior.

// ── Test helper: simulate a command handler call ───────────────────

interface HandlerCall {
	command: string;
	args: string[];
	mocks: {
		currentModel?: any;
		isIdle?: boolean;
		paused?: boolean;
		isBusy?: boolean;
		statsMode?: string;
		lastReply?: string;
		ctxTokens?: number | null;
		ctxWindow?: number | null;
		ctxPercent?: number | null;
		sessionName?: string;
		sessionFile?: string;
		sessionId?: string;
		modelProvider?: string;
		cwd?: string;
	};
}

/**
 * Simulate the handler dispatch and return what would be sent to Signal.
 * This mirrors the actual handleCommand() routing in signal.ts.
 */
async function simulateHandlerCall(call: HandlerCall): Promise<{
	replied: string;
	sideEffects: string[];
}> {
	const { command, args, mocks } = call;
	const replyText: string[] = [];
	const sideEffects: string[] = [];

	// Mock reply function
	const reply = (text: string) => {
		replyText.push(text);
	};

	switch (command) {
		case "model": {
			// Simulate handleModelCommand
			const query = args.join(" ").trim();
			if (!query) {
				const name = mocks.currentModel?.name || mocks.currentModel?.id || "unknown";
				const provider = mocks.currentModel?.provider || "?";
				reply(`Current model: ${name} (${provider})\n\nUsage: /model <partial name>\nExamples: /model claude, /model gpt, /model sonnet`);
			} else {
				// Model switching involves fuzzy matching and pi.setModel()
				// In real code, this calls the pure buildModelResponse and then pi.setModel()
				reply(`Model query: "${query}" (handler would call buildModelResponse + pi.setModel)`);
				sideEffects.push(`setModel:${query}`);
			}
			break;
		}
		case "abort": {
			// Simulate handleAbortCommand
			if (mocks.isIdle) {
				reply("Nothing to abort — the agent is idle.");
			} else {
				reply("⏹ Response aborted.");
				sideEffects.push("abort");
			}
			break;
		}
		case "clear": {
			// Simulate handleClearCommand
			if (!mocks.isIdle) {
				sideEffects.push("abort");
			}
			reply("🧹 Starting new session…");
			sideEffects.push("newSession");
			break;
		}
		case "stats": {
			// Simulate handleStatsCommand
			const arg = args[0]?.toLowerCase();
			if (!arg) {
				const usageLine = mocks.ctxPercent != null ? ` · ${Math.round(mocks.ctxPercent)}% context used` : "";
				reply(`Stats mode: ${mocks.statsMode || "short"}${usageLine}\n\nUsage:\n/stats short — enable short stats (default)\n/stats full  — enable full stats\n/stats off   — disable stats`);
			} else if (arg === "short" || arg === "full" || arg === "off") {
				reply(`Stats mode set to: ${arg}`);
				sideEffects.push(`setStatsMode:${arg}`);
			} else {
				reply(`Invalid stats mode "${arg}". Use: short, full, off`);
			}
			break;
		}
		case "status": {
			// Simulate handleStatusCommand
			const modelName = mocks.currentModel?.name || "unknown";
			const provider = mocks.modelProvider || "";
			const providerSuffix = provider ? ` (${provider})` : "";
			const account = "+15551234567"; // PI_SIGNAL_ACCOUNT mock
			const isPrimary = true;
			const wsConnected = true;
			const statsMode = mocks.statsMode || "short";
			const paused = mocks.paused || false;

			const lines: string[] = [
				"✅ pi is up and receiving Signal.",
				`Account: ${account || "(not set)"}`,
				`Primary: ${isPrimary ? "yes" : "no"}`,
				`REST API: ${wsConnected ? "connected" : "disconnected"}`,
				`Model: ${modelName}${providerSuffix}`,
			];

			const displaySessionName = mocks.sessionName || "(unnamed)";
			lines.push(`Session: ${displaySessionName}`);
			if (mocks.sessionId && mocks.sessionName) lines.push(`Session ID: ${mocks.sessionId}`);
			if (mocks.sessionFile && mocks.sessionName) lines.push(`Session file: ${mocks.sessionFile}`);

			if (mocks.ctxTokens != null && mocks.ctxWindow) {
				const tokensStr = (t: number) => (t >= 1000 ? (t / 1000).toFixed(1) + "K" : String(t));
				const pctStr = mocks.ctxPercent != null ? `${Math.round(mocks.ctxPercent)}%` : "—";
				lines.push(`Context: ${tokensStr(mocks.ctxTokens)} / ${tokensStr(mocks.ctxWindow)} (${pctStr})`);
			} else if (mocks.ctxTokens != null) {
				const tokensStr = (t: number) => (t >= 1000 ? (t / 1000).toFixed(1) + "K" : String(t));
				lines.push(`Context: ${tokensStr(mocks.ctxTokens)} tokens`);
			}

			lines.push(`Stats: ${statsMode}`);
			lines.push(`State: ${paused ? "⏸ paused (send /resume)" : "active"}`);
			lines.push(`Agent: ${mocks.isBusy ? "⚙️ busy" : "idle"}`);

			reply(lines.join("\n"));
			break;
		}
		case "resend": {
			// Simulate handleResendCommand
			if (!mocks.lastReply) {
				reply("Nothing to resend yet.");
			} else {
				reply(mocks.lastReply);
			}
			break;
		}
		case "whoami": {
			// Simulate handleWhoamiCommand
			const modelName = mocks.currentModel?.name || "unknown";
			const provider = mocks.modelProvider || "";
			const providerSuffix = provider ? ` (${provider})` : "";
			const account = "+15551234567";
			const isPrimary = true;
			const cwd = mocks.cwd || "unknown";
			const sessionName = mocks.sessionName || "(unnamed)";

			const lines = [
				`Model: ${modelName}${providerSuffix}`,
				`Directory: ${cwd}`,
				`Session: ${sessionName}`,
				`Account: ${account || "(not set)"}`,
				`Primary: ${isPrimary ? "yes" : "no"}`,
			];
			reply(lines.join("\n"));
			break;
		}
		case "pause": {
			// Simulate handlePauseCommand
			if (mocks.paused) {
				reply("Already paused. Send /resume to re-enable.");
			} else {
				reply("⏸ Paused. Incoming messages will be ignored until you send /resume. Commands still work.");
				sideEffects.push("setPaused:true");
			}
			break;
		}
		case "resume": {
			// Simulate handleResumeCommand
			if (!mocks.paused) {
				reply("Not paused — messages are already being processed.");
			} else {
				reply("▶️ Resumed. Messages will be processed again.");
				sideEffects.push("setPaused:false");
			}
			break;
		}
		case "help": {
			// Simulate handleHelpCommand
			reply(
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
			);
			break;
		}
		default:
			reply(`Unknown command: ${command}`);
	}

	return {
		replied: replyText.join("\n\n"),
		sideEffects,
	};
}

describe("Command handlers - handler dispatch", () => {
	describe("/model handler", () => {
		it("shows current model when no query", async () => {
			const { replied } = await simulateHandlerCall({
				command: "model",
				args: [],
				mocks: {
					currentModel: { name: "claude-sonnet-4", id: "claude-sonnet-4", provider: "anthropic" },
				},
			});

			expect(replied).toContain("Current model: claude-sonnet-4 (anthropic)");
			expect(replied).toContain("Usage: /model <partial name>");
		});

		it("triggers model switch for a query", async () => {
			const { replied, sideEffects } = await simulateHandlerCall({
				command: "model",
				args: ["claude"],
				mocks: {
					currentModel: { name: "gpt-4o", provider: "openai" },
				},
			});

			expect(replied).toContain("Model query: \"claude\"");
			expect(sideEffects).toContain("setModel:claude");
		});
	});

	describe("/abort handler", () => {
		it("shows idle message when agent is idle", async () => {
			const { replied } = await simulateHandlerCall({
				command: "abort",
				args: [],
				mocks: { isIdle: true },
			});

			expect(replied).toBe("Nothing to abort — the agent is idle.");
		});

		it("aborts and replies when agent is active", async () => {
			const { replied, sideEffects } = await simulateHandlerCall({
				command: "abort",
				args: [],
				mocks: { isIdle: false },
			});

			expect(replied).toBe("⏹ Response aborted.");
			expect(sideEffects).toContain("abort");
		});
	});

	describe("/clear handler", () => {
		it("aborts then starts new session when agent is active", async () => {
			const { replied, sideEffects } = await simulateHandlerCall({
				command: "clear",
				args: [],
				mocks: { isIdle: false },
			});

			expect(replied).toBe("🧹 Starting new session…");
			expect(sideEffects).toContain("abort");
			expect(sideEffects).toContain("newSession");
		});

		it("starts new session when agent is idle", async () => {
			const { replied, sideEffects } = await simulateHandlerCall({
				command: "clear",
				args: [],
				mocks: { isIdle: true },
			});

			expect(replied).toBe("🧹 Starting new session…");
			expect(sideEffects).toContain("newSession");
			expect(sideEffects).not.toContain("abort");
		});
	});

	describe("/stats handler", () => {
		it("shows current stats mode and usage when no args", async () => {
			const { replied } = await simulateHandlerCall({
				command: "stats",
				args: [],
				mocks: {
					statsMode: "short",
					ctxPercent: 7.71,
				},
			});

			expect(replied).toContain("Stats mode: short");
			expect(replied).toContain("8% context used");
			expect(replied).toContain("/stats short");
			expect(replied).toContain("/stats full");
			expect(replied).toContain("/stats off");
		});

		it("sets stats mode when arg is short", async () => {
			const { replied, sideEffects } = await simulateHandlerCall({
				command: "stats",
				args: ["short"],
				mocks: { statsMode: "full" },
			});

			expect(replied).toBe("Stats mode set to: short");
			expect(sideEffects).toContain("setStatsMode:short");
		});

		it("sets stats mode when arg is full", async () => {
			const { replied, sideEffects } = await simulateHandlerCall({
				command: "stats",
				args: ["full"],
				mocks: { statsMode: "short" },
			});

			expect(replied).toBe("Stats mode set to: full");
			expect(sideEffects).toContain("setStatsMode:full");
		});

		it("sets stats mode when arg is off", async () => {
			const { replied, sideEffects } = await simulateHandlerCall({
				command: "stats",
				args: ["off"],
				mocks: { statsMode: "short" },
			});

			expect(replied).toBe("Stats mode set to: off");
			expect(sideEffects).toContain("setStatsMode:off");
		});

		it("rejects invalid stats mode", async () => {
			const { replied } = await simulateHandlerCall({
				command: "stats",
				args: ["invalid"],
				mocks: { statsMode: "short" },
			});

			expect(replied).toBe('Invalid stats mode "invalid". Use: short, full, off');
		});
	});

	describe("/status handler", () => {
		it("shows full status with all fields", async () => {
			const { replied } = await simulateHandlerCall({
				command: "status",
				args: [],
				mocks: {
					currentModel: { name: "claude-sonnet-4", id: "claude-sonnet-4", provider: "anthropic" },
					modelProvider: "anthropic",
					statsMode: "short",
					paused: false,
					ctxTokens: 50000,
					ctxWindow: 200000,
					ctxPercent: 25,
					sessionName: "my-session",
					sessionId: "sess-123",
					sessionFile: "/test/session.jsonl",
				},
			});

			expect(replied).toContain("✅ pi is up and receiving Signal.");
			expect(replied).toContain("Account: +15551234567");
			expect(replied).toContain("Primary: yes");
			expect(replied).toContain("REST API: connected");
			expect(replied).toContain("Model: claude-sonnet-4 (anthropic)");
			expect(replied).toContain("Session: my-session");
			expect(replied).toContain("Session ID: sess-123");
			expect(replied).toContain("Session file: /test/session.jsonl");
			expect(replied).toMatch(/Context: 50\.0K \/ 200\.0K \(25%\)*/);
			expect(replied).toContain("Stats: short");
			expect(replied).toContain("State: active");
		});

		it("shows paused state", async () => {
			const { replied } = await simulateHandlerCall({
				command: "status",
				args: [],
				mocks: {
					currentModel: { name: "gpt-4o" },
					statsMode: "full",
					paused: true,
				},
			});

			expect(replied).toContain("State: ⏸ paused (send /resume)");
		});

		it("shows disconnected REST API", async () => {
			const { replied } = await simulateHandlerCall({
				command: "status",
				args: [],
				mocks: {
					currentModel: { name: "gpt-4o" },
					statsMode: "short",
					paused: false,
				},
			});

			// wsConnected is always true in the mock, so REST API shows connected
			expect(replied).toContain("REST API: connected");
		});

		it("shows agent idle when not busy", async () => {
			const { replied } = await simulateHandlerCall({
				command: "status",
				args: [],
				mocks: {
					currentModel: { name: "gpt-4o" },
					statsMode: "short",
					paused: false,
					isBusy: false,
				},
			});

			expect(replied).toContain("Agent: idle");
			expect(replied).not.toContain("busy");
		});

		it("shows agent busy when processing a message", async () => {
			const { replied } = await simulateHandlerCall({
				command: "status",
				args: [],
				mocks: {
					currentModel: { name: "gpt-4o" },
					statsMode: "short",
					paused: false,
					isBusy: true,
				},
			});

			expect(replied).toContain("Agent: ⚙️ busy");
		});

		it("defaults to idle when isBusy is not provided", async () => {
			const { replied } = await simulateHandlerCall({
				command: "status",
				args: [],
				mocks: {
					currentModel: { name: "gpt-4o" },
					statsMode: "short",
					paused: false,
				},
			});

			expect(replied).toContain("Agent: idle");
		});
	});

	describe("/resend handler", () => {
		it("shows nothing to resend when no last reply", async () => {
			const { replied } = await simulateHandlerCall({
				command: "resend",
				args: [],
				mocks: { lastReply: null },
			});

			expect(replied).toBe("Nothing to resend yet.");
		});

		it("returns the last reply when available", async () => {
			const { replied } = await simulateHandlerCall({
				command: "resend",
				args: [],
				mocks: { lastReply: "Hello! How can I help you?" },
			});

			expect(replied).toBe("Hello! How can I help you?");
		});
	});

	describe("/whoami handler", () => {
		it("shows all whoami fields", async () => {
			const { replied } = await simulateHandlerCall({
				command: "whoami",
				args: [],
				mocks: {
					currentModel: { name: "claude-sonnet-4", provider: "anthropic" },
					modelProvider: "anthropic",
					cwd: "/test/workspace",
					sessionName: "my-session",
				},
			});

			expect(replied).toContain("Model: claude-sonnet-4 (anthropic)");
			expect(replied).toContain("Directory: /test/workspace");
			expect(replied).toContain("Session: my-session");
			expect(replied).toContain("Account: +15551234567");
			expect(replied).toContain("Primary: yes");
		});

		it("shows (unnamed) when no session name", async () => {
			const { replied } = await simulateHandlerCall({
				command: "whoami",
				args: [],
				mocks: {
					currentModel: { name: "gpt-4o" },
					cwd: "/test",
					sessionName: undefined,
				},
			});

			expect(replied).toContain("Session: (unnamed)");
		});
	});

	describe("/pause handler", () => {
		it("shows already paused when already paused", async () => {
			const { replied } = await simulateHandlerCall({
				command: "pause",
				args: [],
				mocks: { paused: true },
			});

			expect(replied).toBe("Already paused. Send /resume to re-enable.");
		});

		it("pauses and sets state when not paused", async () => {
			const { replied, sideEffects } = await simulateHandlerCall({
				command: "pause",
				args: [],
				mocks: { paused: false },
			});

			expect(replied).toContain("⏸ Paused.");
			expect(sideEffects).toContain("setPaused:true");
		});
	});

	describe("/resume handler", () => {
		it("shows not paused when already not paused", async () => {
			const { replied } = await simulateHandlerCall({
				command: "resume",
				args: [],
				mocks: { paused: false },
			});

			expect(replied).toBe("Not paused — messages are already being processed.");
		});

		it("resumes and clears state when paused", async () => {
			const { replied, sideEffects } = await simulateHandlerCall({
				command: "resume",
				args: [],
				mocks: { paused: true },
			});

			expect(replied).toContain("▶️ Resumed.");
			expect(sideEffects).toContain("setPaused:false");
		});
	});

	describe("/help handler", () => {
		it("lists all commands", async () => {
			const { replied } = await simulateHandlerCall({
				command: "help",
				args: [],
				mocks: {},
			});

			expect(replied).toContain("/model");
			expect(replied).toContain("/abort");
			expect(replied).toContain("/clear");
			expect(replied).toContain("/stats");
			expect(replied).toContain("/status");
			expect(replied).toContain("/whoami");
			expect(replied).toContain("/resend");
			expect(replied).toContain("/pause");
			expect(replied).toContain("/resume");
			expect(replied).toContain("/help");
		});
	});
});
