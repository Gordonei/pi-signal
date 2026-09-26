// @ts-nocheck
// TypeScript types are provided by pi at runtime via jiti.
// This module uses runtime-only imports; type checking is skipped.

import * as http from "node:http";
import * as https from "node:https";
import { createDebug, isLoggingEnabled } from "./utils.js";

const debug = createDebug("signal-rest");

/**
 * REST client for the bbernhard/signal-cli-rest-api container.
 *
 * Extracted from signal.ts so the send plumbing can be unit-tested in
 * isolation. Create one instance per (daemonUrl, account) pair with
 * createSignalRestClient().
 */
export interface SignalRestClient {
	restApi(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		body?: Record<string, unknown>,
	): Promise<{ ok: boolean; result?: unknown; error?: string }>;
	sendMessage(recipient: string, message: string): Promise<boolean>;
	sendReaction(
		recipient: string,
		targetAuthor: string,
		timestamp: number,
		emoji: string,
	): Promise<boolean>;
	removeReaction(
		recipient: string,
		targetAuthor: string,
		timestamp: number,
	): Promise<boolean>;
	sendTypingIndicator(recipient: string, action: "started" | "stopped"): Promise<boolean>;
	listContacts(): Promise<Array<Record<string, unknown>>>;
	getApiAbout(): Promise<{ ok: boolean; version?: string }>;
}

export function createSignalRestClient(opts: {
	daemonUrl: string;
	account: string;
}): SignalRestClient {
	const { daemonUrl, account } = opts;

	/**
	 * Issue a REST request to the bbernhard/signal-cli-rest-api container.
	 * This replaces the old JSON-RPC daemonRpc() calls.
	 */
	async function restApi(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		body?: Record<string, unknown>,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		const baseUrl = new URL(daemonUrl);
		const target = new URL(path, daemonUrl);

		const isHttps = baseUrl.protocol === "https:";
		const lib = isHttps ? https : http;

		const payload = body ? JSON.stringify(body) : null;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};		// Set Content-Length explicitly so the body is delivered even for
		// methods Node's http client doesn't auto-frame (e.g. DELETE).
		// Without it the body bytes go out unframed and spec-compliant
		// servers treat the request as having no body.
		if (payload !== null) {
			headers["Content-Length"] = String(Buffer.byteLength(payload));
		}

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

			if (payload !== null) {
				req.write(payload);
			}
			req.end();
		});
	}

	/** Send a signal message via the REST API. */
	async function sendMessage(
		recipient: string,
		message: string,
	): Promise<boolean> {
		debug(`[signal] sendMessage -> recipients=[${recipient}], as=${account}`);
		const res = await restApi("POST", "/v1/send", {
			number: account,
			recipients: [recipient],
			message,
		});
		debug(`[signal] sendMessage result: ok=${res.ok}, error=${res.error}`);
		return res.ok;
	}

	/** Send an emoji reaction via the REST API. */
	async function sendReaction(
		recipient: string,
		targetAuthor: string,
		timestamp: number,
		emoji: string,
	): Promise<boolean> {
		const res = await restApi("POST", `/v1/reactions/${encodeURIComponent(account)}`, {
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
		const res = await restApi("DELETE", `/v1/reactions/${encodeURIComponent(account)}`, {
			recipient,
			target_author: targetAuthor,
			timestamp,
		});
		return res.ok;
	}

	/**
	 * Send a typing indicator ("message is being written…") via the REST API.
	 * PUT shows the indicator, DELETE hides it.
	 */
	async function sendTypingIndicator(
		recipient: string,
		action: "started" | "stopped",
	): Promise<boolean> {
		if (!account) return false;
		debug(`[signal] typing indicator ${action} -> ${recipient}`);
		const res = await restApi(
			action === "started" ? "PUT" : "DELETE",
			`/v1/typing-indicator/${encodeURIComponent(account)}`,
			{ recipient },
		);
		debug(`[signal] typing indicator ${action} result: ok=${res.ok}, error=${res.error}`);
		return res.ok;
	}

	/** List contacts via the REST API. */
	async function listContacts(): Promise<Array<Record<string, unknown>>> {
		const res = await restApi("GET", `/v1/contacts/${encodeURIComponent(account)}?all_recipients=true`);
		if (!res.ok || !Array.isArray(res.result)) {
			if (isLoggingEnabled()) console.error(`[signal] listContacts failed: ${res.error || "unknown"}`);
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
	return {
		restApi,
		sendMessage,
		sendReaction,
		removeReaction,
		sendTypingIndicator,
		listContacts,
		getApiAbout,
	};
}
