// @ts-nocheck
// TypeScript types are provided by pi at runtime via jiti.

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as crypto from "node:crypto";
import { createDebug } from "./debug.js";

const debug = createDebug("attachments");

// ── Configuration ─────────────────────────────────────────────────────

export const ATTACHMENTS_DIR =
	process.env.PI_SIGNAL_ATTACHMENTS_DIR || "/tmp/pi-signal/attachments";

const SIGNAL_DAEMON_URL =
	process.env.PI_SIGNAL_DAEMON_URL || "http://127.0.0.1:8090";

const MAX_ATTACHMENT_AGE_DAYS = parseInt(
	process.env.PI_SIGNAL_MAX_ATTACHMENT_AGE_DAYS || "7",
	10,
) || 7;

// ── Helpers ───────────────────────────────────────────────────────────

/** Ensure the attachments directory exists. */
function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/** Generate a safe, unique filename from a URL. */
function filenameFromUrl(url: string): string {
	// Extract extension from URL query params (e.g., ?filename=photo.jpg)
	// or derive from the URL path.
	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname.split("/").pop() || "";
		const extMatch = pathname.match(/\.[a-z0-9]+$/i);
		const ext = extMatch ? extMatch[0] : inferExtension(url);
		const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 8);
		return `${Date.now()}-${hash}${ext}`;
	} catch {
		const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 8);
		return `${Date.now()}-${hash}`;
	}
}

/** Infer file extension from URL content-type hints. */
function inferExtension(url: string): string {
	const lower = url.toLowerCase();
	if (lower.includes("image/jpeg") || lower.match(/\.(jpg|jpeg)$/)) return ".jpg";
	if (lower.includes("image/png") || lower.match(/\.(png)$/)) return ".png";
	if (lower.includes("image/webp") || lower.match(/\.(webp)$/)) return ".webp";
	if (lower.includes("image/gif") || lower.match(/\.(gif)$/)) return ".gif";
	if (lower.includes("application/pdf") || lower.match(/\.(pdf)$/)) return ".pdf";
	if (lower.includes("video/") || lower.match(/\.(mp4|mov|webm)$/)) return ".mp4";
	if (lower.includes("audio/") || lower.match(/\.(mp3|ogg|m4a)$/)) return ".mp3";
	if (lower.includes("text/") || lower.match(/\.(txt|md|csv)$/)) return ".txt";
	if (lower.includes("application/zip") || lower.match(/\.(zip)$/)) return ".zip";
	return "";
}

/** Download a single attachment URL to disk. */
function downloadAttachment(url: string, dir: string): Promise<string | null> {
	return new Promise((resolve) => {
		const filename = filenameFromUrl(url);
		const filePath = path.join(dir, filename);

		const isHttps = url.startsWith("https:");
		const lib = isHttps ? https : http;

		lib.get(url, { timeout: 30_000 }, (res) => {
			// Check for redirect
			if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
				const location = res.headers.location;
				if (location) {
					downloadAttachment(location, dir).then(resolve).catch(() => resolve(null));
					return;
				}
			}

			if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					try {
						const data = Buffer.concat(chunks);
						fs.writeFileSync(filePath, data);
						debug?.(`[attachments] saved: ${filePath} (${data.length} bytes)`);
						resolve(filePath);
					} catch (err) {
						console.error(`[attachments] write error for ${filePath}: ${(err as Error).message}`);
						resolve(null);
					}
				});
			} else {
				debug?.(`[attachments] HTTP ${res.statusCode} for ${url}`);
				resolve(null);
			}
		}).on("error", (err) => {
			console.error(`[attachments] download error: ${(err as Error).message}`);
			resolve(null);
		}).on("timeout", () => {
			debug?.(`[attachments] download timeout for ${url}`);
			resolve(null);
		});
	});
}

/**
 * Construct a signal-cli REST API attachment URL from metadata.
 */
function buildAttachmentUrl(
	daemonUrl: string,
	attachmentId: string,
): string {
	return `${daemonUrl}/v1/attachments/${attachmentId}`;
}

/**
 * Extract and download attachments from a parsed dataMessage envelope.
 * Returns an array of local file paths (empty array if none).
 */
export async function downloadAttachments(
	dataMessage: Record<string, unknown>,
	dir: string = ATTACHMENTS_DIR,
	daemonUrl: string = SIGNAL_DAEMON_URL,
): Promise<string[]> {
	ensureDir(dir);

	const attachments = dataMessage.attachments;
	if (!Array.isArray(attachments)) {
		return [];
	}

	const results: string[] = [];
	for (const attachment of attachments) {
		if (!attachment || typeof attachment !== "object") continue;

		// Try explicit url field first (some signal-cli versions include it)
		let url = (attachment as { url?: string }).url;

		// If no url, construct from the attachment id (signal-cli REST API pattern)
		if (!url) {
			const attachmentId = (attachment as { id?: string }).id;
			if (attachmentId) {
				url = buildAttachmentUrl(daemonUrl, attachmentId);
			}
		}

		if (!url || typeof url !== "string") continue;

		const filePath = await downloadAttachment(url, dir);
		if (filePath) {
			results.push(filePath);
		}
	}

	return results;
}

/** Clean up old attachment files. */
export function cleanupAttachments(
	dir: string = ATTACHMENTS_DIR,
	maxAgeDays: number = MAX_ATTACHMENT_AGE_DAYS,
): void {
	if (!fs.existsSync(dir)) return;

	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = Date.now() - maxAgeMs;

	try {
		const files = fs.readdirSync(dir);
		let cleaned = 0;
		for (const file of files) {
			const filePath = path.join(dir, file);
			try {
				const stat = fs.statSync(filePath);
				if (stat.mtimeMs < cutoff) {
					fs.unlinkSync(filePath);
					cleaned++;
				}
			} catch {
				// File may have been removed already
			}
		}
		if (cleaned > 0) {
			console.error(`[attachments] cleaned ${cleaned} file(s) older than ${maxAgeDays} days from ${dir}`);
		}
	} catch (err) {
		console.error(`[attachments] cleanup error: ${(err as Error).message}`);
	}
}

/** Get attachment directory info (for status/reporting). */
export function getAttachmentInfo(): { dir: string; enabled: boolean; maxAgeDays: number } {
	const dir = ATTACHMENTS_DIR;
	const exists = fs.existsSync(dir);
	return {
		dir,
		enabled: exists,
		maxAgeDays,
	};
}
