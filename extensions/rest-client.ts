// @ts-nocheck
// TypeScript types are provided by pi at runtime via jiti.
// This module uses runtime-only imports; type checking is skipped.

import * as fs from "node:fs";
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
	sendMessageV2(opts: SendV2Options): Promise<{ ok: boolean; error?: string; timestamp?: string }>;
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

/** Options for the v2 send endpoint. */
export interface SendV2Options {
	recipients: string[];
	message: string;
	base64_attachments?: string[];
	view_once?: boolean;
	text_mode?: "normal" | "styled";
}

/** Maximum raw file size in bytes (50 MB). Signal caps attachments at 100 MB; base64 inflates ~33%. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Map common file extensions to MIME types. */
export const extToMime: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	pdf: "application/pdf",
	txt: "text/plain",
	csv: "text/csv",
	md: "text/plain",
	zip: "application/zip",
	rar: "application/x-rar-compressed",
	"7z": "application/x-7z-compressed",
	doc: "application/msword",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Read a local file and return a data URI with MIME type and filename. */
export function fileToBase64(input: string): string {
	let filePath = input;

	// Accept file:// URLs
	try {
		const u = new URL(input);
		if (u.protocol === "file:") {
			filePath = u.pathname;
		} else {
			throw new Error(`Unsupported URL scheme: ${u.protocol}`);
		}
	} catch {
		// Not a URL, treat as path (may be absolute or relative)
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`File not found: ${filePath}`);
		}
		throw err;
	}

	if (!stat.isFile()) {
		throw new Error(`Not a regular file: ${filePath}`);
	}

	if (stat.size > MAX_ATTACHMENT_BYTES) {
		throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB (max 50 MB)`);
	}

	const data = fs.readFileSync(filePath);

	// Determine MIME type from extension
	const extMatch = filePath.match(/\.([^.\/]+)$/i);
	const ext = extMatch ? extMatch[1].toLowerCase() : "";
	const mime = extToMime[ext] || "application/octet-stream";
	const basename = filePath.split(/[\/\\]/).pop() || "file";

	// Build data URI: data:<mime>;filename=<basename>;base64,<data>
	return `data:${mime};filename=${basename};base64,${data.toString("base64")}`;
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

	/** Send a signal message via the REST API (v1). */
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

	/** Send a message with media attachments via the v2 REST API endpoint. */
	async function sendMessageV2(
		opts: SendV2Options,
	): Promise<{ ok: boolean; error?: string; timestamp?: string }> {
		const body: Record<string, unknown> = {
			number: account,
			recipients: opts.recipients,
			message: opts.message,
		};
		if (opts.base64_attachments && opts.base64_attachments.length > 0) {
			body.base64_attachments = opts.base64_attachments;
		}
		if (opts.view_once !== undefined) {
			body.view_once = opts.view_once;
		}
		if (opts.text_mode !== undefined) {
			body.text_mode = opts.text_mode;
		}

		debug(`[signal] sendMessageV2 -> recipients=[${opts.recipients.join(", ")}], attachments=${opts.base64_attachments?.length ?? 0}`);
		const res = await restApi("POST", "/v2/send", body);
		debug(`[signal] sendMessageV2 result: ok=${res.ok}, error=${res.error}`);

		if (!res.ok) {
			return { ok: false, error: res.error ?? "unknown error" };
		}

		// 201 response: parse result for timestamp and per-recipient errors
		const result = res.result as Record<string, unknown> | undefined;
		const timestamp = (result?.timestamp as string) ?? undefined;
		const errors = result?.errors as Array<{ number?: string; uuid?: string; reason?: string }> | undefined;

		if (errors && errors.length > 0) {
			const parts = errors.map((e) => {
				const id = e.number || e.uuid || "unknown";
				return `${id}: ${e.reason || "unknown error"}`;
			});
			return { ok: false, error: parts.join("; ") };
		}

		return { ok: true, timestamp };
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
		sendMessageV2,
		sendReaction,
		removeReaction,
		sendTypingIndicator,
		listContacts,
		getApiAbout,
		fileToBase64,
	};
}
