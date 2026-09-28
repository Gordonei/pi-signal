/**
 * Unit tests for the Signal REST client (extensions/rest-client.ts).
 *
 * Uses a real local HTTP server on 127.0.0.1 with an ephemeral port — no
 * external services. Covers the send plumbing: restApi (core request
 * handling), sendMessage, reactions, typing indicator, contacts, about.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createSignalRestClient, fileToBase64, extToMime } from "../../extensions/rest-client";

const ACCOUNT = "+15551234567";
const RECIPIENT = "+15559876543";

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

interface HandlerResult {
  status?: number;
  body?: unknown;
  /** Raw (non-JSON) response body. Takes precedence over `body`. */
  raw?: string;
}

type Handler = (req: RecordedRequest) => HandlerResult;

let server: http.Server;
let daemonUrl: string;
let client: ReturnType<typeof createSignalRestClient>;
let requests: RecordedRequest[];
let handler: Handler;

async function startServer(): Promise<void> {
  requests = [];
  handler = () => ({ body: { success: true } });

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const rec: RecordedRequest = {
        method: req.method || "",
        url: req.url || "",
        body,
      };
      requests.push(rec);

      const { status = 200, body: out, raw: outRaw } = handler(rec);
      res.writeHead(status, { "Content-Type": "application/json" });
      if (outRaw !== undefined) {
        res.end(outRaw);
      } else if (out === undefined) {
        res.end();
      } else {
        res.end(JSON.stringify(out));
      }
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;
  daemonUrl = `http://127.0.0.1:${port}`;
  client = createSignalRestClient({ daemonUrl, account: ACCOUNT });
}

beforeEach(async () => {
  await startServer();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── restApi (core request handling) ─────────────────────────────────

describe("restApi", () => {
  it("returns parsed JSON for a 200 response", async () => {
    handler = () => ({ body: { hello: "world" } });
    const res = await client.restApi("GET", "/v1/anything");
    expect(res).toEqual({ ok: true, result: { hello: "world" } });
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe("/v1/anything");
  });

  it("sends a JSON body for POST requests", async () => {
    handler = () => ({ body: { success: true } });
    const res = await client.restApi("POST", "/v1/send", { a: 1 });
    expect(res.ok).toBe(true);
    expect(requests[0].body).toEqual({ a: 1 });
  });

  it("returns null for an empty 204 response", async () => {
    handler = () => ({ status: 204 });
    const res = await client.restApi("DELETE", "/v1/x");
    expect(res).toEqual({ ok: true, result: null });
  });

  it("returns the raw text for a non-JSON 200 response", async () => {
    handler = () => ({ raw: "plain text" });
    const res = await client.restApi("GET", "/v1/x");
    expect(res).toEqual({ ok: true, result: "plain text" });
  });

  it("returns the JSON error field for error statuses", async () => {
    handler = () => ({ status: 400, body: { error: "bad request" } });
    const res = await client.restApi("GET", "/v1/x");
    expect(res).toEqual({ ok: false, error: "bad request" });
  });

  it("returns an HTTP status error for non-JSON error bodies", async () => {
    handler = () => ({ status: 500, raw: "boom" });
    const res = await client.restApi("GET", "/v1/x");
    expect(res).toEqual({ ok: false, error: "HTTP 500" });
  });

  it("returns a connection error when the daemon is unreachable", async () => {
    const offline = createSignalRestClient({
      daemonUrl: "http://127.0.0.1:1", // port 1 — nothing listens there
      account: ACCOUNT,
    });
    const res = await offline.restApi("GET", "/v1/about");
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

// ── sendMessage ─────────────────────────────────────────────────────

describe("sendMessage", () => {
  it("POSTs to /v1/send with the account and returns true on success", async () => {
    const ok = await client.sendMessage(RECIPIENT, "hi there");
    expect(ok).toBe(true);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("/v1/send");
    expect(requests[0].body).toEqual({
      number: ACCOUNT,
      recipients: [RECIPIENT],
      message: "hi there",
    });
  });

  it("returns false when the API reports an error", async () => {
    handler = () => ({ status: 400, body: { error: "no route to recipient" } });
    const ok = await client.sendMessage(RECIPIENT, "hi");
    expect(ok).toBe(false);
  });
});

// ── Reactions ───────────────────────────────────────────────────────

describe("reactions", () => {
  const TS = 1700000000000;

  it("sendReaction POSTs the emoji to /v1/reactions/{account}", async () => {
    const ok = await client.sendReaction(RECIPIENT, RECIPIENT, TS, "👀");
    expect(ok).toBe(true);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe(
      `/v1/reactions/${encodeURIComponent(ACCOUNT)}`,
    );
    expect(requests[0].body).toEqual({
      reaction: "👀",
      recipient: RECIPIENT,
      target_author: RECIPIENT,
      timestamp: TS,
    });
  });

  it("removeReaction DELETEs with the same wire format minus the emoji", async () => {
    const ok = await client.removeReaction(RECIPIENT, RECIPIENT, TS);
    expect(ok).toBe(true);
    expect(requests[0].method).toBe("DELETE");
    expect(requests[0].url).toBe(
      `/v1/reactions/${encodeURIComponent(ACCOUNT)}`,
    );
    expect(requests[0].body).toEqual({
      recipient: RECIPIENT,
      target_author: RECIPIENT,
      timestamp: TS,
    });
  });
});

// ── Typing indicator ────────────────────────────────────────────────

describe("sendTypingIndicator", () => {
  it("PUTs /v1/typing-indicator/{account} for 'started'", async () => {
    const ok = await client.sendTypingIndicator(RECIPIENT, "started");
    expect(ok).toBe(true);
    expect(requests[0].method).toBe("PUT");
    expect(requests[0].url).toBe(
      `/v1/typing-indicator/${encodeURIComponent(ACCOUNT)}`,
    );
    expect(requests[0].body).toEqual({ recipient: RECIPIENT });
  });

  it("DELETEs for 'stopped'", async () => {
    const ok = await client.sendTypingIndicator(RECIPIENT, "stopped");
    expect(ok).toBe(true);
    expect(requests[0].method).toBe("DELETE");
  });

  it("returns false and sends nothing when the account is empty", async () => {
    const noAccount = createSignalRestClient({ daemonUrl, account: "" });
    const ok = await noAccount.sendTypingIndicator(RECIPIENT, "started");
    expect(ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

// ── Contacts & about ────────────────────────────────────────────────

describe("listContacts", () => {
  it("GETs /v1/contacts/{account}?all_recipients=true and returns the array", async () => {
    handler = () => ({
      body: [
        { name: "Alice", number: RECIPIENT },
        { name: "Bob", number: "+15551112222" },
      ],
    });
    const contacts = await client.listContacts();
    expect(contacts).toEqual([
      { name: "Alice", number: RECIPIENT },
      { name: "Bob", number: "+15551112222" },
    ]);
    expect(requests[0].url).toBe(
      `/v1/contacts/${encodeURIComponent(ACCOUNT)}?all_recipients=true`,
    );
  });

  it("returns [] when the API errors", async () => {
    handler = () => ({ status: 500, raw: "down" });
    const contacts = await client.listContacts();
    expect(contacts).toEqual([]);
  });

  it("returns [] when the result is not an array", async () => {
    handler = () => ({ body: { name: "oops" } });
    const contacts = await client.listContacts();
    expect(contacts).toEqual([]);
  });
});

describe("getApiAbout", () => {
  it("returns the version from /v1/about", async () => {
    handler = () => ({ body: { version: "1.2.3" } });
    const about = await client.getApiAbout();
    expect(about).toEqual({ ok: true, version: "1.2.3" });
    expect(requests[0].url).toBe("/v1/about");
  });

  it("returns { ok: false } when the API errors", async () => {
    handler = () => ({ status: 500, raw: "down" });
    const about = await client.getApiAbout();
    expect(about).toEqual({ ok: false });
  });
});

// ── sendMessageV2 ────────────────────────────────────────────────────

describe("sendMessageV2", () => {
  it("POSTs to /v2/send with required fields", async () => {
    const res = await client.sendMessageV2({
      recipients: [RECIPIENT],
      message: "hello",
    });
    expect(res.ok).toBe(true);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("/v2/send");
    expect(requests[0].body).toEqual({
      number: ACCOUNT,
      recipients: [RECIPIENT],
      message: "hello",
    });
  });

  it("includes base64_attachments when provided", async () => {
    const res = await client.sendMessageV2({
      recipients: [RECIPIENT],
      message: "",
      base64_attachments: ["data:image/png;base64,AAA", "rawb64"],
    });
    expect(res.ok).toBe(true);
    expect((requests[0].body as any).base64_attachments).toEqual([
      "data:image/png;base64,AAA",
      "rawb64",
    ]);
  });

  it("omits base64_attachments when empty", async () => {
    const res = await client.sendMessageV2({
      recipients: [RECIPIENT],
      message: "no attachments",
    });
    expect(res.ok).toBe(true);
    expect((requests[0].body as any).hasOwnProperty("base64_attachments")).toBe(false);
  });

  it("includes view_once when provided", async () => {
    const res = await client.sendMessageV2({
      recipients: [RECIPIENT],
      message: "",
      view_once: true,
    });
    expect(res.ok).toBe(true);
    expect((requests[0].body as any).view_once).toBe(true);
  });

  it("includes text_mode when provided", async () => {
    const res = await client.sendMessageV2({
      recipients: [RECIPIENT],
      message: "styled",
      text_mode: "styled",
    });
    expect(res.ok).toBe(true);
    expect((requests[0].body as any).text_mode).toBe("styled");
  });

  it("returns { ok: true, timestamp } on 201", async () => {
    handler = () => ({ status: 201, body: { timestamp: "1234567890000" } });
    const res = await client.sendMessageV2({
      recipients: [RECIPIENT],
      message: "hi",
    });
    expect(res).toEqual({ ok: true, timestamp: "1234567890000" });
  });

  it("returns { ok: false, error } when response has per-recipient errors", async () => {
    handler = () => ({
      status: 201,
      body: {
        timestamp: "12345",
        errors: [{ number: "+123", reason: "rate limited" }],
      },
    });
    const res = await client.sendMessageV2({
      recipients: [RECIPIENT],
      message: "hi",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("+123");
    expect(res.error).toContain("rate limited");
  });

  it("returns { ok: false, error } on non-2xx", async () => {
    handler = () => ({ status: 400, body: { error: "bad request" } });
    const res = await client.sendMessageV2({
      recipients: [RECIPIENT],
      message: "hi",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bad request");
  });

  it("omits view_once when not provided", async () => {
    const res = await client.sendMessageV2({
      recipients: [RECIPIENT],
      message: "hi",
    });
    expect(res.ok).toBe(true);
    expect((requests[0].body as any).hasOwnProperty("view_once")).toBe(false);
  });
});

// ── fileToBase64 ─────────────────────────────────────────────────────

describe("fileToBase64", () => {
  const tmpDir = "/tmp/pi-signal-test-attachments";

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("reads a file and returns a data URI with correct MIME type", () => {
    const testFile = `${tmpDir}/test.txt`;
    fs.writeFileSync(testFile, "hello world");
    const result = fileToBase64(testFile);
    expect(result).toMatch(/^data:text\/plain;filename=test\.txt;base64,/);
    const b64 = result.split("base64,")[1];
    expect(Buffer.from(b64, "base64").toString()).toBe("hello world");
  });

  it("infers MIME type for common extensions", () => {
    const tests: [string, string, string][] = [
      ["test.jpg", "image/jpeg", "fake jpeg"],
      ["test.png", "image/png", "fake png"],
      ["test.gif", "image/gif", "fake gif"],
      ["test.pdf", "application/pdf", "fake pdf"],
      ["test.mp4", "video/mp4", "fake mp4"],
      ["test.mp3", "audio/mpeg", "fake mp3"],
    ];

    for (const [filename, mime, content] of tests) {
      const f = `${tmpDir}/${filename}`;
      fs.writeFileSync(f, content);
      const result = fileToBase64(f);
      expect(result).toMatch(new RegExp(`^data:${mime};filename=${filename};base64,`));
      fs.unlinkSync(f);
    }
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    const f = `${tmpDir}/unknown.xyz`;
    fs.writeFileSync(f, "xyz");
    const result = fileToBase64(f);
    expect(result).toMatch(/^data:application\/octet-stream;/);
  });

  it("accepts file:// URLs", () => {
    const f = `${tmpDir}/url-test.txt`;
    fs.writeFileSync(f, "via url");
    const result = fileToBase64(`file://${f}`);
    expect(result).toMatch(/^data:text\/plain;/);
    const b64 = result.split("base64,")[1];
    expect(Buffer.from(b64, "base64").toString()).toBe("via url");
  });

  it("throws ENOENT with a friendly message", () => {
    expect(() => fileToBase64("/tmp/nonexistent-file-abc123.txt")).toThrow("File not found");
  });

  it("catches unsupported URL schemes as file-not-found (known limitation)", () => {
    // The try/catch around URL parsing catches ALL errors including the
    // "Unsupported URL scheme" throw — so it falls through to statSync.
    // Line 92 is currently unreachable without refactoring the catch block.
    expect(() => fileToBase64("http://example.com/file.txt")).toThrow("File not found");
  });

  it("throws when given a directory", () => {
    expect(() => fileToBase64(tmpDir)).toThrow("Not a regular file");
  });

  it("throws when file exceeds 50 MB", () => {
    const f = `${tmpDir}/oversized.bin`;
    // Create a file just over 50 MB
    const large = Buffer.alloc(50 * 1024 * 1024 + 1);
    fs.writeFileSync(f, large);
    expect(() => fileToBase64(f)).toThrow("File too large");
    fs.unlinkSync(f);
  });
});

// ── extToMime ────────────────────────────────────────────────────────

describe("extToMime", () => {
  it("maps known extensions to MIME types", () => {
    expect(extToMime["jpg"]).toBe("image/jpeg");
    expect(extToMime["png"]).toBe("image/png");
    expect(extToMime["pdf"]).toBe("application/pdf");
    expect(extToMime["mp4"]).toBe("video/mp4");
    expect(extToMime["txt"]).toBe("text/plain");
  });

  it("has a fallback entry for unknown extensions", () => {
    // No entry for 'xyz' — should return undefined
    expect((extToMime as Record<string, string | undefined>)["xyz"]).toBeUndefined();
  });
});
