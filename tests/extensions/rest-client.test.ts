/**
 * Unit tests for the Signal REST client (extensions/rest-client.ts).
 *
 * Uses a real local HTTP server on 127.0.0.1 with an ephemeral port — no
 * external services. Covers the send plumbing: restApi (core request
 * handling), sendMessage, reactions, typing indicator, contacts, about.
 */

import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createSignalRestClient } from "../../extensions/rest-client";

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
