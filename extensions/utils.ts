// ── Debug helper ──────────────────────────────────────────────────────

export function isLoggingEnabled(): boolean {
	const val = (typeof process !== "undefined"
		? (process.env.PI_SIGNAL_DEBUG || "false")
		: "false"
	).toLowerCase();
	return val === "true" || val === "1" || val === "log";
}

export function createDebug(prefix: string): (...args: unknown[]) => void {
	return function debug(...args: unknown[]): void {
		if (isLoggingEnabled()) {
			console.log(`[${prefix}]`, ...args);
		}
	};
}

/**
 * Shared utility functions for the pi-signal extension.
 * These are extracted to be independently testable.
 */

/**
 * Check whether a phone number is allowed to communicate with the Signal bot.
 *
 * Rules:
 * - The bot's own account number is always allowed.
 * - If PI_SIGNAL_ALLOWLIST is set, those numbers are additionally allowed.
 * - If PI_SIGNAL_ALLOWLIST is empty, only the bot's own account is allowed.
 *
 * @param number - The phone number in E.164 format (e.g. "+15551234567")
 */
export function isAllowedNumber(
  number: string,
  account: string,
  allowlist: string,
): boolean {
  const cleaned = number.replace(/[\s\-().]/g, '');
  // Self is always allowed
  if (cleaned === account) return true;
  // If allowlist is set, check against it
  if (allowlist) {
    const allowedNumbers = new Set(
      allowlist
        .split(',')
        .map((n) => n.replace(/[\s\-().]/g, ''))
        .filter((n) => /^[+]?\d+$/.test(n)),
    );
    return allowedNumbers.has(cleaned);
  }
  // Empty allowlist = only self allowed
  return false;
}

/**
 * Compute the Levenshtein edit distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]) + 1;
    }
  }
  return dp[m][n];
}

/**
 * Fuzzy-match a query against a list of model labels, returning scored results.
 * Lower score = better match.
 */
export interface FuzzyMatchResult {
  label: string;
  score: number;
}

export function fuzzyMatchModels(
  query: string,
  labels: string[],
): FuzzyMatchResult[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const scored: FuzzyMatchResult[] = [];

  for (const label of labels) {
    const labelLower = label.toLowerCase();
    let score = Infinity;

    if (labelLower === q) {
      score = 0;
    } else if (labelLower.includes(q)) {
      const pos = labelLower.indexOf(q);
      score = 0.02 + (pos / Math.max(labelLower.length, 1)) * 0.05;
    } else {
      const dist = levenshtein(labelLower, q);
      const maxLen = Math.max(labelLower.length, q.length);
      score = dist / Math.max(maxLen, 1);
    }

    scored.push({ label, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.label.length - b.label.length;
  });

  return scored;
}

/**
 * Sanitize a contact name by stripping control characters and whitespace.
 */
export function sanitizeContactName(s: string): string {
  return s
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/**
 * Format a token count for display. Values >= 1000 are shown as "X.XK".
 */
export function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

/**
 * Build a stats footer string for appending to Signal messages.
 */
export interface ContextUsage {
  tokens?: number;
  percent?: number;
  contextWindow?: number;
}

export interface ModelInfo {
  name?: string;
  id?: string;
  provider?: string;
}

export function buildStatsFooter(
  usage: ContextUsage | null,
  model: ModelInfo | null,
  mode: 'short' | 'full' | 'off',
): string {
  if (mode === 'off') return '';

  const modelName = model?.name || model?.id || 'unknown';
  const provider = model?.provider || '';
  const tokensIn = usage?.tokens != null ? usage.tokens : null;
  const pct = usage?.percent != null ? usage.percent : null;

  if (mode === 'short') {
    const parts: string[] = [modelName];
    if (tokensIn != null) {
      parts.push(formatTokens(tokensIn) + ' ctx');
    }
    if (pct != null) {
      parts.push(Math.round(pct) + '%');
    }
    return '\n───\n' + parts.join(' · ');
  }

  // Full mode
  const ctxWindow = usage?.contextWindow || null;
  const lines: string[] = ['───'];
  lines.push(`Model: ${modelName}${provider ? ' (' + provider + ')' : ''}`);
  if (tokensIn != null) {
    lines.push(`Context: ${tokensIn.toLocaleString()} tokens`);
  }
  if (ctxWindow != null) {
    lines.push(`Window: ${ctxWindow.toLocaleString()} tokens`);
  }
  if (pct != null) {
    lines.push(`Usage: ${Math.round(pct)}%`);
  }
  return '\n' + lines.join('\n');
}

/**
 * Parse a phone number string, stripping common non-digit characters.
 */
export function normalizePhoneNumber(number: string): string {
  return number.replace(/[\s\-().]/g, '');
}

/**
 * Validate that a string is a proper E.164 phone number.
 */
export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(phone);
}

// ── Message plumbing (pure, extracted from signal.ts) ──────────────

/** A parsed incoming Signal message ready for routing. */
export interface ParsedSignalMessage {
  sender: string;
  number: string;
  body: string;
  timestamp: number;
  /** Local paths of downloaded attachment files (empty if none). */
  attachments: string[];
}

/**
 * Parse a raw JSON string from the bbernhard/signal-cli-rest-api WebSocket
 * into a message the extension can act on.
 *
 * Returns null when the message must be dropped:
 * - invalid JSON or non-object payload
 * - no envelope found (neither `params.envelope` nor top-level `envelope`)
 * - no body and no downloaded attachments
 * - a synced message destined for someone other than the own account
 *
 * @param data - raw JSON string received on the WebSocket
 * @param account - the bot's own E.164 number (PI_SIGNAL_ACCOUNT)
 * @param downloadAttachments - optional callback; invoked with the
 *   dataMessage when it carries an `attachments` array. Must resolve to an
 *   array of local file paths. When omitted, no downloads happen.
 */
export async function parseSignalEnvelope(
  data: string,
  account: string,
  downloadAttachments?: (
    dataMessage: Record<string, unknown>,
  ) => Promise<string[]>,
): Promise<ParsedSignalMessage | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;

  // In json-rpc-native mode the envelope is under `params`;
  // in native mode it sits directly on the object.
  const paramsObj = obj.params as Record<string, unknown> | undefined;
  const env =
    (paramsObj?.envelope as Record<string, unknown> | undefined) ||
    (obj.envelope as Record<string, unknown> | undefined);
  if (!env) return null;

  // Extract message body
  let body: string | undefined;
  let isNoteToSelf = false;

  // Check dataMessage (normal incoming messages)
  if (env.dataMessage && typeof env.dataMessage === 'object') {
    const dm = env.dataMessage as Record<string, unknown>;
    body = (dm.body as string | undefined) || (dm.message as string | undefined);
  }

  // Check syncMessage (Note to Self / synced from other devices)
  if (!body && env.syncMessage && typeof env.syncMessage === 'object') {
    const sm = env.syncMessage as Record<string, unknown>;
    if (sm.sentMessage && typeof sm.sentMessage === 'object') {
      const sentMsg = sm.sentMessage as Record<string, unknown>;
      const destination =
        (sentMsg.destinationNumber as string | undefined) ||
        (sentMsg.destination as string | undefined);
      body =
        (sentMsg.message as string | undefined) ||
        (sentMsg.body as string | undefined);
      if (body && account && destination === account) {
        isNoteToSelf = true;
      } else if (body) {
        // A synced message to someone else — ignore it.
        return null;
      }
    }
    if (!body) {
      body = (sm.body as string | undefined) || (sm.message as string | undefined);
    }
  }

  // Extract message timestamp
  let timestamp: number = 0;
  if (env.dataMessage && typeof env.dataMessage === 'object') {
    timestamp =
      ((env.dataMessage as Record<string, unknown>).timestamp as number) || 0;
  }
  if (!timestamp && isNoteToSelf && env.syncMessage && typeof env.syncMessage === 'object') {
    const sm = env.syncMessage as Record<string, unknown>;
    if (sm.sentMessage && typeof sm.sentMessage === 'object') {
      timestamp =
        ((sm.sentMessage as Record<string, unknown>).timestamp as number) || 0;
    }
  }

  // Extract sender number
  let number = 'unknown';
  if (isNoteToSelf && account) {
    number = account;
  } else if (typeof env.sourceNumber === 'string' && env.sourceNumber) {
    number = env.sourceNumber;
  } else if (typeof env.source === 'string' && env.source) {
    number = env.source;
  }

  // Extract sender display name
  let sender: string = number;
  if (isNoteToSelf) {
    sender = 'Self';
  } else if (typeof env.sourceName === 'string' && env.sourceName) {
    sender = env.sourceName;
  }

  // Download any attachments from the message
  let downloadedAttachments: string[] = [];
  if (
    env.dataMessage &&
    typeof env.dataMessage === 'object' &&
    downloadAttachments &&
    Array.isArray((env.dataMessage as Record<string, unknown>).attachments)
  ) {
    downloadedAttachments = await downloadAttachments(
      env.dataMessage as Record<string, unknown>,
    );
  }

  // If no body and no attachments, drop the message
  if (!body || typeof body !== 'string' || body.trim() === '') {
    if (downloadedAttachments.length === 0) {
      return null;
    }
    body = '[Image attachment]';
  }

  return { sender, number, body: body.trim(), timestamp, attachments: downloadedAttachments };
}

/**
 * Build the prompt string sent to the agent for an incoming Signal message.
 *
 * Pinned current behavior:
 *   [Signal from <sender> (<number>)]: <body>
 * with, when attachments exist, an appended line:
 *   
 *   [Attachments: <path1>, <path2>]
 *
 * Note: Note-to-Self messages are NOT exempt from the prefix
 * (sender is "Self").
 */
export function formatIncomingMessage(
  parsed: ParsedSignalMessage,
): string {
  const attachmentPaths = parsed.attachments.join(', ');
  let formatted = `[Signal from ${parsed.sender} (${parsed.number})]: ${parsed.body}`;
  if (attachmentPaths) {
    formatted += `\n\n[Attachments: ${attachmentPaths}]`;
  }
  return formatted;
}

/**
 * Extract the reply text from the messages of an `agent_end` event.
 *
 * Pinned current behavior: text is taken from ALL assistant messages
 * (string content, or `text` parts inside array content), joined with
 * newlines and trimmed. Returns null when there is no assistant message
 * or no non-empty text (the caller then skips sending a reply).
 */
export function extractReplyText(
  messages: Array<{ role?: string; content?: unknown }>,
): string | null {
  const assistantMessages = (messages || []).filter(
    (m) => m && m.role === 'assistant',
  );
  if (assistantMessages.length === 0) return null;

  const textParts: string[] = [];
  for (const msg of assistantMessages) {
    const content = msg.content;
    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          (part as { type?: string }).type === 'text'
        ) {
          const text = (part as { text?: string }).text;
          if (text) textParts.push(text);
        }
      }
    }
  }

  const fullText = textParts.join('\n').trim();
  return fullText || null;
}
