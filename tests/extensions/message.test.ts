/**
 * Pure unit tests for the Signal message plumbing (no network, no WS, no pi).
 *
 * Covers:
 *  - parseSignalEnvelope(): raw WebSocket JSON string → parsed message | null
 *  - formatIncomingMessage(): parsed message → exact agent prompt string
 *  - extractReplyText(): agent_end messages → reply text | null
 *
 * Message shapes under test:
 *  1. ordinary text messages
 *  2. text messages with attachments
 *  3. messages with just attachments (no body / placeholder captions)
 */

import {
  parseSignalEnvelope,
  formatIncomingMessage,
  extractReplyText,
  ParsedSignalMessage,
} from "../../extensions/utils";

const ACCOUNT = "+15551234567";
const SENDER = "+15559876543";

/** Wrap an envelope in the json-rpc-native WebSocket frame format. */
function wrap(envelope: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "receive",
    params: { envelope, account: ACCOUNT },
  });
}

/** Envelope in native (non json-rpc) frame format: envelope at top level. */
function wrapNative(envelope: Record<string, unknown>): string {
  return JSON.stringify({ envelope, account: ACCOUNT });
}

/**
 * A fake attachment downloader: resolves to the given local paths, one per
 * attachment entry in the dataMessage (count-based, ignores URLs).
 */
function downloadStub(paths: string[]) {
  return jest.fn(async (dm: Record<string, unknown>) => {
    const atts = dm.attachments;
    if (!Array.isArray(atts)) return [];
    if (paths.length === 0) return [];
    return atts.map((_, i) => paths[i % paths.length]);
  });
}

// ── parseSignalEnvelope ─────────────────────────────────────────────

describe("parseSignalEnvelope", () => {
  describe("ordinary text messages", () => {
    it("parses a plain dataMessage with name and number", async () => {
      const result = await parseSignalEnvelope(
        wrap({
          sourceNumber: SENDER,
          sourceName: "Alice",
          dataMessage: { body: "hello", timestamp: 1700000000000 },
        }),
        ACCOUNT,
      );
      expect(result).toEqual({
        sender: "Alice",
        number: SENDER,
        body: "hello",
        timestamp: 1700000000000,
        attachments: [],
      });
    });

    it("falls back to dataMessage.message when body is absent", async () => {
      const result = await parseSignalEnvelope(
        wrap({
          sourceNumber: SENDER,
          sourceName: "Alice",
          dataMessage: { message: "hi there", timestamp: 1 },
        }),
        ACCOUNT,
      );
      expect(result?.body).toBe("hi there");
    });

    it("uses the number as sender when sourceName is missing", async () => {
      const result = await parseSignalEnvelope(
        wrap({
          sourceNumber: SENDER,
          dataMessage: { body: "hello" },
        }),
        ACCOUNT,
      );
      expect(result?.sender).toBe(SENDER);
      expect(result?.number).toBe(SENDER);
    });

    it("falls back to `source` when sourceNumber is missing", async () => {
      const result = await parseSignalEnvelope(
        wrap({
          source: SENDER,
          sourceName: "Alice",
          dataMessage: { body: "hello" },
        }),
        ACCOUNT,
      );
      expect(result?.number).toBe(SENDER);
    });

    it("uses 'unknown' when neither sourceNumber nor source is present", async () => {
      const result = await parseSignalEnvelope(
        wrap({ dataMessage: { body: "hello" } }),
        ACCOUNT,
      );
      expect(result?.number).toBe("unknown");
      expect(result?.sender).toBe("unknown");
    });

    it("trims surrounding whitespace from the body", async () => {
      const result = await parseSignalEnvelope(
        wrap({
          sourceNumber: SENDER,
          sourceName: "Alice",
          dataMessage: { body: "  spaced out  " },
        }),
        ACCOUNT,
      );
      expect(result?.body).toBe("spaced out");
    });

    it("defaults timestamp to 0 when missing", async () => {
      const result = await parseSignalEnvelope(
        wrap({ sourceNumber: SENDER, dataMessage: { body: "hello" } }),
        ACCOUNT,
      );
      expect(result?.timestamp).toBe(0);
    });

    it("parses an envelope at the top level (native mode)", async () => {
      const result = await parseSignalEnvelope(
        wrapNative({
          sourceNumber: SENDER,
          sourceName: "Alice",
          dataMessage: { body: "native", timestamp: 42 },
        }),
        ACCOUNT,
      );
      expect(result?.body).toBe("native");
      expect(result?.timestamp).toBe(42);
    });

    it("prefers params.envelope over a top-level envelope", async () => {
      const data = JSON.stringify({
        envelope: { dataMessage: { body: "wrong" } },
        params: {
          envelope: {
            sourceNumber: SENDER,
            sourceName: "Alice",
            dataMessage: { body: "right" },
          },
        },
      });
      const result = await parseSignalEnvelope(data, ACCOUNT);
      expect(result?.body).toBe("right");
    });
  });

  describe("text messages with attachments", () => {
    const attEnvelope = {
      sourceNumber: SENDER,
      sourceName: "Alice",
      dataMessage: {
        body: "check this out",
        timestamp: 1700000000000,
        attachments: [
          { id: "a1", url: "http://daemon/attachments/a1" },
          { id: "a2", url: "http://daemon/attachments/a2" },
        ],
      },
    };

    it("keeps the body and returns downloaded local paths", async () => {
      const download = downloadStub(["/tmp/pi-signal/attachments/a1.jpg", "/tmp/pi-signal/attachments/a2.png"]);
      const result = await parseSignalEnvelope(wrap(attEnvelope), ACCOUNT, download);
      expect(result?.body).toBe("check this out");
      expect(result?.attachments).toEqual([
        "/tmp/pi-signal/attachments/a1.jpg",
        "/tmp/pi-signal/attachments/a2.png",
      ]);
      expect(download).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ body: "check this out" }),
      );
    });

    it("does not call the downloader when attachments is not an array", async () => {
      const download = downloadStub(["/x"]);
      const env = {
        ...attEnvelope,
        dataMessage: {
          ...attEnvelope.dataMessage,
          attachments: { id: "a1" }, // not an array
        },
      };
      const result = await parseSignalEnvelope(wrap(env), ACCOUNT, download);
      expect(result?.attachments).toEqual([]);
      expect(download).not.toHaveBeenCalled();
    });

    it("does not crash when no downloader is provided", async () => {
      const result = await parseSignalEnvelope(wrap(attEnvelope), ACCOUNT);
      expect(result?.body).toBe("check this out");
      expect(result?.attachments).toEqual([]);
    });

    it("handles a downloader that returns no paths", async () => {
      const result = await parseSignalEnvelope(
        wrap(attEnvelope),
        ACCOUNT,
        downloadStub([]),
      );
      // Body present, so the message is kept even though nothing downloaded.
      expect(result?.body).toBe("check this out");
      expect(result?.attachments).toEqual([]);
    });
  });

  describe("messages with just attachments (no body)", () => {
    const noBodyEnvelope = {
      sourceNumber: SENDER,
      sourceName: "Alice",
      dataMessage: {
        timestamp: 1700000000000,
        attachments: [{ id: "a1", url: "http://daemon/attachments/a1" }],
      },
    };

    it("substitutes a placeholder body when there is no body key", async () => {
      const result = await parseSignalEnvelope(
        wrap(noBodyEnvelope),
        ACCOUNT,
        downloadStub(["/tmp/pi-signal/attachments/a1.jpg"]),
      );
      expect(result?.body).toBe("[Image attachment]");
      expect(result?.attachments).toEqual(["/tmp/pi-signal/attachments/a1.jpg"]);
    });

    it("substitutes a placeholder body for an empty body string", async () => {
      const env = {
        ...noBodyEnvelope,
        dataMessage: { ...noBodyEnvelope.dataMessage, body: "" },
      };
      const result = await parseSignalEnvelope(
        wrap(env),
        ACCOUNT,
        downloadStub(["/tmp/a.jpg"]),
      );
      expect(result?.body).toBe("[Image attachment]");
    });

    it("substitutes a placeholder body for a whitespace-only body", async () => {
      const env = {
        ...noBodyEnvelope,
        dataMessage: { ...noBodyEnvelope.dataMessage, body: "   " },
      };
      const result = await parseSignalEnvelope(
        wrap(env),
        ACCOUNT,
        downloadStub(["/tmp/a.jpg"]),
      );
      expect(result?.body).toBe("[Image attachment]");
    });

    it("keeps placeholder captions such as 'Photo' as-is (pinned behavior)", async () => {
      const env = {
        ...noBodyEnvelope,
        dataMessage: { ...noBodyEnvelope.dataMessage, body: "Photo" },
      };
      const result = await parseSignalEnvelope(
        wrap(env),
        ACCOUNT,
        downloadStub(["/tmp/a.jpg"]),
      );
      expect(result?.body).toBe("Photo");
      expect(result?.attachments).toEqual(["/tmp/a.jpg"]);
    });

    it("drops the message when there is no body and no attachments", async () => {
      const result = await parseSignalEnvelope(
        wrap({ sourceNumber: SENDER, dataMessage: { timestamp: 1 } }),
        ACCOUNT,
      );
      expect(result).toBeNull();
    });

    it("drops the message when the body is empty and nothing downloads", async () => {
      const env = {
        sourceNumber: SENDER,
        dataMessage: { body: "", attachments: [{ id: "a1" }] },
      };
      const result = await parseSignalEnvelope(
        wrap(env),
        ACCOUNT,
        downloadStub([]), // everything failed to download
      );
      expect(result).toBeNull();
    });

    it("drops the message when there is no body and no downloader is wired in", async () => {
      const result = await parseSignalEnvelope(wrap(noBodyEnvelope), ACCOUNT);
      expect(result).toBeNull();
    });
  });

  describe("Note-to-Self messages (syncMessage)", () => {
    const ntsEnvelope = {
      syncMessage: {
        sentMessage: {
          destinationNumber: ACCOUNT,
          message: "buy milk",
          timestamp: 1700000001234,
        },
      },
    };

    it("marks a synced sentMessage to the own account as Note-to-Self", async () => {
      const result = await parseSignalEnvelope(wrap(ntsEnvelope), ACCOUNT);
      expect(result).toEqual({
        sender: "Self",
        number: ACCOUNT,
        body: "buy milk",
        timestamp: 1700000001234,
        attachments: [],
      });
    });

    it("supports the `destination` and `body` field variants", async () => {
      const env = {
        syncMessage: {
          sentMessage: { destination: ACCOUNT, body: "note", timestamp: 5 },
        },
      };
      const result = await parseSignalEnvelope(wrap(env), ACCOUNT);
      expect(result?.sender).toBe("Self");
      expect(result?.number).toBe(ACCOUNT);
      expect(result?.body).toBe("note");
      expect(result?.timestamp).toBe(5);
    });

    it("drops a synced sentMessage destined for someone else", async () => {
      const env = {
        syncMessage: {
          sentMessage: {
            destinationNumber: "+15550000000",
            message: "not for me",
          },
        },
      };
      const result = await parseSignalEnvelope(wrap(env), ACCOUNT);
      expect(result).toBeNull();
    });

    it("drops a synced sentMessage when destination is missing", async () => {
      const env = {
        syncMessage: { sentMessage: { message: "no destination" } },
      };
      const result = await parseSignalEnvelope(wrap(env), ACCOUNT);
      expect(result).toBeNull();
    });

    it("reads a bare syncMessage body when there is no sentMessage", async () => {
      const env = {
        sourceNumber: SENDER,
        sourceName: "Alice",
        syncMessage: { body: "synced text" },
      };
      const result = await parseSignalEnvelope(wrap(env), ACCOUNT);
      expect(result?.body).toBe("synced text");
      expect(result?.sender).toBe("Alice");
      expect(result?.number).toBe(SENDER);
    });
  });

  describe("malformed input", () => {
    it("returns null for invalid JSON", async () => {
      expect(await parseSignalEnvelope("not json {", ACCOUNT)).toBeNull();
    });

    it("returns null for an empty string", async () => {
      expect(await parseSignalEnvelope("", ACCOUNT)).toBeNull();
    });

    it("returns null for non-object JSON", async () => {
      expect(await parseSignalEnvelope('"just a string"', ACCOUNT)).toBeNull();
      expect(await parseSignalEnvelope("42", ACCOUNT)).toBeNull();
      expect(await parseSignalEnvelope("null", ACCOUNT)).toBeNull();
    });

    it("returns null when no envelope is present", async () => {
      expect(
        await parseSignalEnvelope(
          JSON.stringify({ jsonrpc: "2.0", method: "heartbeat" }),
          ACCOUNT,
        ),
      ).toBeNull();
    });

    it("returns null for an empty envelope object", async () => {
      expect(await parseSignalEnvelope(wrap({}), ACCOUNT)).toBeNull();
    });

    it("treats a non-object dataMessage as absent", async () => {
      expect(
        await parseSignalEnvelope(
          wrap({ dataMessage: "garbage" }),
          ACCOUNT,
        ),
      ).toBeNull();
    });
  });
});

// ── formatIncomingMessage ───────────────────────────────────────────

describe("formatIncomingMessage", () => {
  const base: ParsedSignalMessage = {
    sender: "Alice",
    number: SENDER,
    body: "hello",
    timestamp: 0,
    attachments: [],
  };

  it("formats an ordinary text message", () => {
    expect(formatIncomingMessage(base)).toBe(
      `[Signal from Alice (${SENDER})]: hello`,
    );
  });

  it("uses the same prefix for Note-to-Self messages (pinned behavior)", () => {
    expect(
      formatIncomingMessage({
        ...base,
        sender: "Self",
        number: ACCOUNT,
        body: "buy milk",
      }),
    ).toBe(`[Signal from Self (${ACCOUNT})]: buy milk`);
  });

  it("appends the attachment list for text + attachments", () => {
    expect(
      formatIncomingMessage({
        ...base,
        body: "check this",
        attachments: ["/tmp/a/1.jpg", "/tmp/a/2.png"],
      }),
    ).toBe(
      `[Signal from Alice (${SENDER})]: check this\n\n[Attachments: /tmp/a/1.jpg, /tmp/a/2.png]`,
    );
  });

  it("formats an attachments-only message with the placeholder body (pinned)", () => {
    expect(
      formatIncomingMessage({
        ...base,
        body: "[Image attachment]",
        attachments: ["/tmp/a/1.jpg"],
      }),
    ).toBe(
      `[Signal from Alice (${SENDER})]: [Image attachment]\n\n[Attachments: /tmp/a/1.jpg]`,
    );
  });

  it("formats an attachments-only message with a 'Photo' caption (pinned)", () => {
    expect(
      formatIncomingMessage({
        ...base,
        body: "Photo",
        attachments: ["/tmp/a/1.jpg"],
      }),
    ).toBe(`[Signal from Alice (${SENDER})]: Photo\n\n[Attachments: /tmp/a/1.jpg]`);
  });

  it("omits the attachment line when there are no attachments", () => {
    expect(formatIncomingMessage(base)).not.toContain("[Attachments:");
  });
});

// ── extractReplyText ────────────────────────────────────────────────

describe("extractReplyText", () => {
  it("returns null for an empty message list", () => {
    expect(extractReplyText([])).toBeNull();
  });

  it("returns null when there are no assistant messages", () => {
    expect(
      extractReplyText([
        { role: "user", content: "hi" },
        { role: "toolResult", content: "ok" },
      ]),
    ).toBeNull();
  });

  it("returns string content verbatim (trimmed)", () => {
    expect(
      extractReplyText([{ role: "assistant", content: "  Hello there  " }]),
    ).toBe("Hello there");
  });

  it("joins text from multiple assistant messages with newlines (pinned)", () => {
    expect(
      extractReplyText([
        { role: "assistant", content: "first" },
        { role: "assistant", content: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("extracts only text parts from array content, in order", () => {
    expect(
      extractReplyText([
        {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "thinking", thinking: "hmm" },
            { type: "toolCall", name: "bash", arguments: {} },
            { type: "text", text: "b" },
          ],
        },
      ]),
    ).toBe("a\nb");
  });

  it("mixes string and array content across messages", () => {
    expect(
      extractReplyText([
        { role: "assistant", content: "intro" },
        { role: "user", content: "user text" },
        {
          role: "assistant",
          content: [{ type: "text", text: "outro" }],
        },
      ]),
    ).toBe("intro\noutro");
  });

  it("returns null when the assistant only made tool calls", () => {
    expect(
      extractReplyText([
        {
          role: "assistant",
          content: [
            { type: "toolCall", name: "bash", arguments: { command: "ls" } },
            { type: "thinking", thinking: "planning" },
          ],
        },
      ]),
    ).toBeNull();
  });

  it("skips empty-string text parts", () => {
    expect(
      extractReplyText([
        {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "text", text: "real" },
          ],
        },
      ]),
    ).toBe("real");
  });

  it("returns null when all text is whitespace", () => {
    expect(
      extractReplyText([
        { role: "assistant", content: "   " },
        { role: "assistant", content: [{ type: "text", text: "  " }] },
      ]),
    ).toBeNull();
  });

  it("skips text parts with a missing text field", () => {
    expect(
      extractReplyText([
        {
          role: "assistant",
          content: [
            { type: "text" },
            { type: "text", text: undefined },
            { type: "text", text: "found" },
          ],
        },
      ]),
    ).toBe("found");
  });

  it("ignores null entries and non-object array parts", () => {
    expect(
      extractReplyText([
        null as unknown as { role?: string; content?: unknown },
        { role: "assistant", content: [null, 42, { type: "text", text: "ok" }] },
      ]),
    ).toBe("ok");
  });
});

// ── Full pipeline: parse → format (pure end-to-end) ─────────────────

describe("full pipeline (parseSignalEnvelope → formatIncomingMessage)", () => {
  it("ordinary text message", async () => {
    const parsed = await parseSignalEnvelope(
      wrap({
        sourceNumber: SENDER,
        sourceName: "Alice",
        dataMessage: { body: "hello", timestamp: 1 },
      }),
      ACCOUNT,
    );
    expect(parsed).not.toBeNull();
    expect(formatIncomingMessage(parsed!)).toBe(
      `[Signal from Alice (${SENDER})]: hello`,
    );
  });

  it("text message with attachments", async () => {
    const parsed = await parseSignalEnvelope(
      wrap({
        sourceNumber: SENDER,
        sourceName: "Alice",
        dataMessage: {
          body: "check this",
          timestamp: 1,
          attachments: [{ id: "a1" }, { id: "a2" }],
        },
      }),
      ACCOUNT,
      downloadStub(["/tmp/a/1.jpg", "/tmp/a/2.png"]),
    );
    expect(parsed).not.toBeNull();
    expect(formatIncomingMessage(parsed!)).toBe(
      `[Signal from Alice (${SENDER})]: check this\n\n[Attachments: /tmp/a/1.jpg, /tmp/a/2.png]`,
    );
  });

  it("message with just attachments (no body)", async () => {
    const parsed = await parseSignalEnvelope(
      wrap({
        sourceNumber: SENDER,
        sourceName: "Alice",
        dataMessage: {
          timestamp: 1,
          attachments: [{ id: "a1", url: "http://daemon/attachments/a1" }],
        },
      }),
      ACCOUNT,
      downloadStub(["/tmp/a/1.jpg"]),
    );
    expect(parsed).not.toBeNull();
    expect(formatIncomingMessage(parsed!)).toBe(
      `[Signal from Alice (${SENDER})]: [Image attachment]\n\n[Attachments: /tmp/a/1.jpg]`,
    );
  });

  it("message with just attachments and a 'Photo' caption", async () => {
    const parsed = await parseSignalEnvelope(
      wrap({
        sourceNumber: SENDER,
        sourceName: "Alice",
        dataMessage: {
          body: "Photo",
          timestamp: 1,
          attachments: [{ id: "a1" }],
        },
      }),
      ACCOUNT,
      downloadStub(["/tmp/a/1.jpg"]),
    );
    expect(parsed).not.toBeNull();
    expect(formatIncomingMessage(parsed!)).toBe(
      `[Signal from Alice (${SENDER})]: Photo\n\n[Attachments: /tmp/a/1.jpg]`,
    );
  });
});
