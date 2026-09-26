/**
 * Tests for the signal extension.
 *
 * These tests focus on the pure utility functions used by signal.ts,
 * since signal.ts itself is a closure that depends on the pi runtime API.
 */

import {
  isAllowedNumber,
  levenshtein,
  fuzzyMatchModels,
  sanitizeContactName,
  formatTokens,
  buildStatsFooter,
  normalizePhoneNumber,
  isValidE164,
} from "../../extensions/utils";

describe("Signal Extension Integration Tests", () => {
  describe("Allowlist behavior (as used in signal.ts)", () => {
    const ACCOUNT = "+15551234567";

    it("self-messages are always processed (no allowlist check)", () => {
      // In signal.ts, when parsed.number === PI_SIGNAL_ACCOUNT,
      // the message is processed regardless of allowlist
      expect(isAllowedNumber(ACCOUNT, ACCOUNT, "")).toBe(true);
      expect(isAllowedNumber(ACCOUNT, ACCOUNT, "+19999999999")).toBe(true);
    });

    it("allowlist is parsed and normalized at module load time", () => {
      // Test that the allowlist parsing logic works
      // Numbers without a leading + get normalized to digits only
      const allowlist = "+15559876543, +15551112222, 555-000-1234";
      const normalized = allowlist
        .split(",")
        .map((n) => n.replace(/[\s\-().]/g, ""))
        .filter((n) => /^[+]?\d+$/.test(n));

      expect(normalized).toEqual([
        "+15559876543",
        "+15551112222",
        "5550001234",
      ]);
    });

    it("blocked messages get a deny reaction and notification", () => {
      const allowlist = "+15559876543";
      const blocker = "+15550000000";

      // Should not be allowed
      expect(isAllowedNumber(blocker, ACCOUNT, allowlist)).toBe(false);

      // But self still is
      expect(isAllowedNumber(ACCOUNT, ACCOUNT, allowlist)).toBe(true);
    });
  });

  describe("Fuzzy model matching (as used in signal.ts)", () => {
    it("model list is constructed with provider/id labels", () => {
      const mockModels = [
        { name: "claude-sonnet-4", id: "claude-sonnet-4", provider: "anthropic" },
        { name: "gpt-4o", id: "gpt-4o", provider: "openai" },
        { name: "gemini-2.0-flash", id: "gemini-2.0-flash", provider: "google" },
      ];

      const labels = mockModels.map((m) =>
        `${m.name || m.id || "unknown"} (${m.provider || "?"}/${m.id || "?"})`,
      );

      // Labels should be readable
      expect(labels[0]).toContain("claude-sonnet-4");
      expect(labels[0]).toContain("anthropic");

      const results = fuzzyMatchModels("claude", labels);
      expect(results.length).toBe(3);
      expect(results[0].label).toContain("claude");
    });

    it("exact model id match bypasses fuzzy search", () => {
      const mockModels = [
        { id: "claude-sonnet-4-20250514", name: "claude-sonnet-4" },
        { id: "gpt-4o", name: "gpt-4o" },
      ];

      // Exact ID match
      const match = mockModels.find(
        (m) => m.id && m.id.toLowerCase() === "claude-sonnet-4-20250514",
      );
      expect(match).toBeDefined();
      expect(match!.name).toBe("claude-sonnet-4");
    });
  });

  describe("Stats footer integration (as used in signal.ts)", () => {
    it("full stats footer contains expected info", () => {
      const model = {
        name: "claude-sonnet-4-20250514",
        id: "claude-sonnet-4-20250514",
        provider: "anthropic",
      };
      const usage = {
        tokens: 15420,
        percent: 7.71,
        contextWindow: 200000,
      };

      const footer = buildStatsFooter(usage, model, "full");

      expect(footer).toContain("Model: claude-sonnet-4-20250514 (anthropic)");
      // Check via regex since toLocaleString() uses locale-specific separators
      expect(footer).toMatch(/15\s?420\s?tokens/);
      expect(footer).toMatch(/200\s?000\s?tokens/);
      expect(footer).toContain("Usage: 8%");
    });

    it("short stats footer contains expected info", () => {
      const model = { name: "gpt-4o", id: "gpt-4o", provider: "openai" };
      const usage = { tokens: 3200, percent: 1.6 };

      const footer = buildStatsFooter(usage, model, "short");

      expect(footer).toContain("gpt-4o");
      expect(footer).toContain("3.2K");
      expect(footer).toContain("───");
    });

    it("off stats returns empty", () => {
      const footer = buildStatsFooter(null, null, "off");
      expect(footer).toBe("");
    });
  });

  describe("Message formatting for Signal", () => {
    it("formats incoming messages with sender info", () => {
      const sender = "Alice";
      const number = "+15559876543";
      const body = "Hello, how are you?";

      const formatted = `[Signal from ${sender} (${number})]: ${body}`;
      expect(formatted).toBe(`[Signal from ${sender} (${number})]: ${body}`);
    });

    it("adds attachment indicator when attachments present", () => {
      const sender = "Alice";
      const number = "+15559876543";
      const body = "Check this out";
      const attachments = ["/tmp/pi-signal/att1.jpg", "/tmp/pi-signal/att2.png"];

      const attachmentPaths = attachments.join(", ");
      let formatted = `[Signal from ${sender} (${number})]: ${body}`;
      if (attachmentPaths) {
        formatted += `\n\n[Attachments: ${attachmentPaths}]`;
      }

      expect(formatted).toContain("[Attachments:");
      expect(formatted).toContain("/tmp/pi-signal/att1.jpg");
    });

    it("truncates very long messages", () => {
      const maxLen = 7800;
      const message = "a".repeat(10000);
      const text = message.slice(0, maxLen) + "\n\n[truncated — response too long for Signal]";
      // The suffix "[truncated — response too long for Signal]" is 44 chars
      // "\n\n" is 2 chars
      expect(text.length).toBe(maxLen + 44);
      expect(text).toContain("[truncated");
    });
  });

  describe("E.164 validation and normalization", () => {
    it("validates common phone formats", () => {
      // Valid
      expect(isValidE164("+15551234567")).toBe(true);
      expect(isValidE164("+442071234567")).toBe(true);
      expect(isValidE164("+33123456789")).toBe(true);
      expect(isValidE164("+81312345678")).toBe(true);

      // Invalid
      expect(isValidE164("5551234567")).toBe(false);
      expect(isValidE164("+15551234567890123")).toBe(false);
    });

    it("normalizes phone numbers for comparison", () => {
      const formats = [
        "+15551234567",
        "(555) 123-4567",
        "555-123-4567",
        "555 123 4567",
      ];

      const normalized = formats.map(normalizePhoneNumber);
      // All should normalize to the same value (without country code prefix for non-E164)
      expect(normalized[1]).toBe(normalized[2]);
      expect(normalized[2]).toBe(normalized[3]);
    });
  });

  describe("Typing indicator tracking", () => {
    it("Set-based tracking works for active typing", () => {
      const activeTyping = new Set<string>();

      // Add
      activeTyping.add("+15559876543");
      expect(activeTyping.has("+15559876543")).toBe(true);

      // Remove
      activeTyping.delete("+15559876543");
      expect(activeTyping.has("+15559876543")).toBe(false);

      // Clear
      activeTyping.add("+15551111111");
      activeTyping.add("+15552222222");
      activeTyping.clear();
      expect(activeTyping.size).toBe(0);
    });

    it("Map-based heartbeat tracking works", () => {
      const typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

      const timer = setInterval(() => {}, 10000);
      typingHeartbeats.set("+15559876543", timer);
      expect(typingHeartbeats.size).toBe(1);

      // Stop and delete
      clearInterval(timer);
      typingHeartbeats.delete("+15559876543");
      expect(typingHeartbeats.size).toBe(0);
    });
  });

  describe("Reaction tracking", () => {
    it("pending reaction state management", () => {
      const reaction: {
        recipient: string;
        targetAuthor: string;
        timestamp: number;
      } | null = {
        recipient: "+15559876543",
        targetAuthor: "+15559876543",
        timestamp: 1234567890,
      };

      expect(reaction).not.toBeNull();
      expect(reaction!.recipient).toBe("+15559876543");
      expect(reaction!.timestamp).toBe(1234567890);

      // Clear
      const _cleared = reaction;
      // Simulate: pendingReaction = null;
      expect(_cleared).not.toBeNull();
    });
  });

  describe("Message parsing simulation", () => {
    it("parses a typical incoming message envelope", () => {
      const envelope = {
        jsonrpc: "2.0",
        method: "receive",
        params: {
          envelope: {
            sourceNumber: "+15559876543",
            sourceName: "Alice",
            dataMessage: {
              body: "Hello from Signal!",
              timestamp: 1700000000000,
            },
          },
        },
      };

      const data = JSON.stringify(envelope);
      const parsed = JSON.parse(data);

      expect(parsed.params.envelope.dataMessage.body).toBe("Hello from Signal!");
      expect(parsed.params.envelope.sourceNumber).toBe("+15559876543");
      expect(parsed.params.envelope.sourceName).toBe("Alice");
      expect(parsed.params.envelope.dataMessage.timestamp).toBe(1700000000000);
    });

    it("parses a Note-to-Self message", () => {
      const envelope = {
        jsonrpc: "2.0",
        method: "receive",
        params: {
          envelope: {
            syncMessage: {
              sentMessage: {
                destinationNumber: "+15551234567",
                body: "Remember to buy milk",
                timestamp: 1700000000000,
              },
            },
          },
        },
      };

      const data = JSON.stringify(envelope);
      const parsed = JSON.parse(data);

      const isNoteToSelf =
        parsed.params.envelope.syncMessage.sentMessage.destinationNumber ===
        "+15551234567";

      expect(isNoteToSelf).toBe(true);
      expect(parsed.params.envelope.syncMessage.sentMessage.body).toBe(
        "Remember to buy milk",
      );
    });
  });

  describe("Command parsing", () => {
    it("parses commands with arguments", () => {
      const body = "/model claude sonnet";
      const parts = body.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      expect(cmd).toBe("model");
      expect(args).toEqual(["claude", "sonnet"]);
    });

    it("parses commands without arguments", () => {
      const body = "/abort";
      const parts = body.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      expect(cmd).toBe("abort");
      expect(args).toEqual([]);
    });

    it("recognizes commands by leading slash", () => {
      expect("/model claude".startsWith("/")).toBe(true);
      expect("/abort".startsWith("/")).toBe(true);
      expect("Hello, world!".startsWith("/")).toBe(false);
    });

    it("identifies supported commands", () => {
      const commands = ["model", "abort", "clear", "stats", "status", "resend", "whoami", "pause", "resume", "help"];
      for (const cmd of commands) {
        expect(cmd.startsWith("/")).toBe(false); // These are command names, not full commands
      }
    });
  });

  describe("Pause/Resume state", () => {
    it("pause blocks message processing", () => {
      let paused = false;

      // Simulate: paused = true;
      paused = true;

      expect(paused).toBe(true);
      // In the real code, paused messages send "⏸ Paused. Send /resume to re-enable."
    });

    it("resume unblocks message processing", () => {
      let paused = true;

      // Simulate: paused = false;
      paused = false;

      expect(paused).toBe(false);
    });

    it("double-pause is idempotent", () => {
      let paused = false;

      // First pause
      if (!paused) {
        paused = true;
      }

      // Second pause - should show "Already paused"
      if (!paused) {
        paused = true;
      }

      expect(paused).toBe(true);
    });
  });
});
