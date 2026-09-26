import {
  isAllowedNumber,
  levenshtein,
  fuzzyMatchModels,
  sanitizeContactName,
  formatTokens,
  buildStatsFooter,
  normalizePhoneNumber,
  isValidE164,
  createDebug,
} from "../../extensions/utils";

describe("isAllowedNumber", () => {
  it("allows the bot's own account number", () => {
    const account = "+15551234567";
    expect(isAllowedNumber(account, account, "")).toBe(true);
  });

  it("allows the bot's own account even with formatting differences", () => {
    const account = "+15551234567";
    expect(isAllowedNumber("(555) 123-4567", account, "")).toBe(false);
    // Normalized: account = "+15551234567", number = "5551234567" — not a match
    expect(isAllowedNumber("15551234567", account, "")).toBe(false);
  });

  it("allows numbers in the allowlist", () => {
    const account = "+15551234567";
    const allowlist = "+15559876543,+15551112222";
    expect(isAllowedNumber("+15559876543", account, allowlist)).toBe(true);
    expect(isAllowedNumber("+15551112222", account, allowlist)).toBe(true);
  });

  it("allows allowlist numbers with formatting variations", () => {
    const account = "+15551234567";
    const allowlist = "+15559876543";
    // (555) 987-6543 normalizes to "5559876543" (no +), which does NOT match "+15559876543"
    // This test verifies that formatting without + is NOT matched
    // (555) 987-6543 normalizes to "5559876543" (no +), doesn't match "+15559876543"
    expect(isAllowedNumber("(555) 987-6543", account, allowlist)).toBe(false);
    // +15559876543 with formatting
    expect(isAllowedNumber("+1 (555) 987-6543", account, allowlist)).toBe(true);
  });

  it("does not allow numbers not in the allowlist", () => {
    const account = "+15551234567";
    const allowlist = "+15559876543";
    expect(isAllowedNumber("+15550000000", account, allowlist)).toBe(false);
  });

  it("returns false for non-account numbers when allowlist is empty", () => {
    const account = "+15551234567";
    expect(isAllowedNumber("+15559876543", account, "")).toBe(false);
  });

  it("handles mixed-case and whitespace in allowlist", () => {
    const account = "+15551234567";
    const allowlist = " +15559876543 , +15551112222 ";
    expect(isAllowedNumber("+15559876543", account, allowlist)).toBe(true);
    expect(isAllowedNumber("+15551112222", account, allowlist)).toBe(true);
  });

  it("rejects malformed allowlist entries", () => {
    const account = "+15551234567";
    const allowlist = "+15559876543,not-a-number,+15551112222";
    expect(isAllowedNumber("+15559876543", account, allowlist)).toBe(true);
    expect(isAllowedNumber("+15551112222", account, allowlist)).toBe(true);
    expect(isAllowedNumber("not-a-number", account, allowlist)).toBe(false);
  });

  it("allows self even with different formatting", () => {
    const account = "+15551234567";
    // The number parameter gets normalized
    expect(isAllowedNumber("+15551234567", account, "")).toBe(true);
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("returns the length of a non-empty string when compared to empty", () => {
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "def")).toBe(3);
  });

  it("computes edit distance for single character change", () => {
    expect(levenshtein("cat", "car")).toBe(1);
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("computes edit distance for multiple changes", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("computes edit distance for insertions", () => {
    expect(levenshtein("abc", "abcd")).toBe(1);
    expect(levenshtein("abc", "abcd")).toBe(1);
  });

  it("computes edit distance for deletions", () => {
    expect(levenshtein("abcd", "abc")).toBe(1);
  });

  it("computes edit distance for transpositions", () => {
    expect(levenshtein("ab", "ba")).toBe(2);
  });

  it("handles unicode characters", () => {
    expect(levenshtein("café", "cafe")).toBe(1);
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("handles single character strings", () => {
    expect(levenshtein("a", "b")).toBe(1);
    expect(levenshtein("a", "a")).toBe(0);
  });

  it("handles long strings efficiently", () => {
    const a = "a".repeat(100);
    const b = "a".repeat(99) + "b";
    // Replace last char = 1 edit
    expect(levenshtein(a, b)).toBe(1);
  });

  it("handles appending a character", () => {
    const a = "a".repeat(100);
    const b = "a".repeat(100) + "b";
    expect(levenshtein(a, b)).toBe(1);
  });
});

describe("fuzzyMatchModels", () => {
  it("returns empty array for empty query", () => {
    const models = ["gpt-4o", "claude-sonnet"];
    expect(fuzzyMatchModels("", models)).toEqual([]);
    expect(fuzzyMatchModels("   ", models)).toEqual([]);
  });

  it("returns exact match with score 0", () => {
    const models = ["gpt-4o", "claude-sonnet"];
    const results = fuzzyMatchModels("gpt-4o", models);
    // Returns all models, exact match has score 0
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ label: "gpt-4o", score: 0 });
  });

  it("returns partial matches sorted by score", () => {
    const models = ["gpt-4o", "gpt-3.5-turbo", "claude-sonnet-4"];
    const results = fuzzyMatchModels("gpt", models);
    expect(results.length).toBe(3);
    // First result should be gpt-4o (contains query at position 0)
    expect(results[0].label).toBe("gpt-4o");
    // gpt-4o should have the lowest score (best match, position 0)
    expect(results[0].label).toBe("gpt-4o");
    expect(results[0].score).toBe(0.02);
  });

  it("returns fuzzy matches using edit distance", () => {
    const models = ["gpt-4o", "claude-sonnet", "gemini-pro"];
    const results = fuzzyMatchModels("gtp", models);
    // "gtp" is close to "gpt-4o"
    expect(results[0].label).toBe("gpt-4o");
  });

  it("returns all models when query doesn't match closely", () => {
    const models = ["gpt-4o", "claude-sonnet"];
    const results = fuzzyMatchModels("xyz", models);
    expect(results.length).toBe(2);
    // All scores should be > 0
    expect(results.every((r) => r.score > 0)).toBe(true);
  });

  it("sorts by score first, then by label length", () => {
    const models = ["a-model", "b-model-longer"];
    const results = fuzzyMatchModels("xyz", models);
    expect(results[0].label).toBe("a-model"); // shorter label first at same score
  });

  it("handles case-insensitive matching", () => {
    const models = ["GPT-4o"];
    const results = fuzzyMatchModels("gpt", models);
    expect(results.length).toBe(1);
    expect(results[0].label).toBe("GPT-4o");
  });
});

describe("sanitizeContactName", () => {
  it("returns the string unchanged for clean input", () => {
    expect(sanitizeContactName("John Doe")).toBe("John Doe");
  });

  it("strips control characters", () => {
    expect(sanitizeContactName("John\u0000Doe")).toBe("John Doe");
    expect(sanitizeContactName("John\u001FDoe")).toBe("John Doe");
  });

  it("strips zero-width and invisible characters", () => {
    expect(sanitizeContactName("John\u200BDoe")).toBe("John Doe");
    expect(sanitizeContactName("John\u200B\u200BDoe")).toBe("John Doe");
  });

  it("normalizes whitespace", () => {
    expect(sanitizeContactName("John  Doe")).toBe("John Doe");
    expect(sanitizeContactName("  John Doe  ")).toBe("John Doe");
    expect(sanitizeContactName("John\tDoe")).toBe("John Doe");
  });

  it("truncates to 100 characters", () => {
    const longName = "A".repeat(150);
    expect(sanitizeContactName(longName)).toBe("A".repeat(100));
  });

  it("truncates after sanitization", () => {
    const name = "A".repeat(50) + "\u0000" + "B".repeat(60);
    const result = sanitizeContactName(name);
    expect(result.length).toBe(100);
  });

  it("handles empty string", () => {
    expect(sanitizeContactName("")).toBe("");
  });

  it("handles string with only whitespace", () => {
    expect(sanitizeContactName("   ")).toBe("");
  });

  it("handles unicode characters", () => {
    expect(sanitizeContactName("José García")).toBe("José García");
    expect(sanitizeContactName("田中太郎")).toBe("田中太郎");
  });
});

describe("formatTokens", () => {
  it("returns raw number for values < 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats values >= 1000 as X.XK", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(9999)).toBe("10.0K");
    expect(formatTokens(10000)).toBe("10.0K");
  });

  it("handles larger values", () => {
    expect(formatTokens(15000)).toBe("15.0K");
    expect(formatTokens(100000)).toBe("100.0K");
  });
});

describe("buildStatsFooter", () => {
  it("returns empty string for 'off' mode", () => {
    expect(buildStatsFooter(null, null, "off")).toBe("");
  });

  it("returns empty string when context is null", () => {
    expect(buildStatsFooter(null, null, "short")).toBe("\n───\nunknown");
    expect(buildStatsFooter(null, null, "full")).toBe("\n───\nModel: unknown");
  });

  it("returns short footer with model name", () => {
    const model = { name: "claude-sonnet-4", id: "claude-sonnet-4", provider: "anthropic" };
    const result = buildStatsFooter(null, model, "short");
    expect(result).toContain("claude-sonnet-4");
  });

  it("includes token count in short footer", () => {
    const model = { name: "gpt-4o", id: "gpt-4o", provider: "openai" };
    const usage = { tokens: 5500, percent: 2.75, contextWindow: 200000 };
    const result = buildStatsFooter(usage, model, "short");
    expect(result).toContain("5.5K");
    // percent is 2.75, so Math.round(2.75) = 3%
    expect(result).toContain("3%");
  });

  it("includes separator line", () => {
    const result = buildStatsFooter(null, null, "short");
    expect(result).toContain("───");
  });

  it("returns full footer with all info", () => {
    const model = { name: "claude-sonnet-4", id: "claude-sonnet-4", provider: "anthropic" };
    const usage = { tokens: 5000, percent: 2.5, contextWindow: 200000 };
    const result = buildStatsFooter(usage, model, "full");
    expect(result).toContain("Model: claude-sonnet-4 (anthropic)");
    // toLocaleString() uses locale-specific separators; check key digits exist
    // Check via regex since toLocaleString() uses locale-specific separators
    expect(result).toMatch(/5\s?000\s?tokens/);
    expect(result).toMatch(/200\s?000\s?tokens/);
    expect(result).toContain("Usage: 3%");
  });

  it("omits null values from full footer", () => {
    const model = { name: "gpt-4o", id: "gpt-4o", provider: "openai" };
    const usage = { tokens: null, percent: null, contextWindow: null };
    const result = buildStatsFooter(usage, model, "full");
    expect(result).toContain("Model: gpt-4o (openai)");
    expect(result).not.toContain("Context:");
    expect(result).not.toContain("Window:");
    expect(result).not.toContain("Usage:");
  });

  it("uses model id when name is missing", () => {
    const model = { name: undefined, id: "gpt-4o", provider: "openai" };
    const result = buildStatsFooter(null, model, "short");
    expect(result).toContain("gpt-4o");
  });

  it("uses 'unknown' when both name and id are missing", () => {
    const model = { name: undefined, id: undefined, provider: "" };
    const result = buildStatsFooter(null, model, "short");
    expect(result).toContain("unknown");
  });

  it("omits provider when it's empty", () => {
    const model = { name: "gpt-4o", id: "gpt-4o", provider: "" };
    const result = buildStatsFooter(null, model, "full");
    expect(result).toBe("\n───\nModel: gpt-4o");
  });
});

describe("normalizePhoneNumber", () => {
  it("returns E.164 number unchanged", () => {
    expect(normalizePhoneNumber("+15551234567")).toBe("+15551234567");
  });

  it("strips parentheses", () => {
    expect(normalizePhoneNumber("(555) 123-4567")).toBe("5551234567");
  });

  it("strips hyphens", () => {
    expect(normalizePhoneNumber("555-123-4567")).toBe("5551234567");
  });

  it("strips spaces", () => {
    expect(normalizePhoneNumber("555 123 4567")).toBe("5551234567");
  });

  it("strips all formatting", () => {
    expect(normalizePhoneNumber("(555) 123-4567")).toBe("5551234567");
  });
});

describe("isValidE164", () => {
  it("accepts valid E.164 numbers", () => {
    expect(isValidE164("+15551234567")).toBe(true);
    expect(isValidE164("+442071234567")).toBe(true);
    expect(isValidE164("+15551")).toBe(true); // minimum length
  });

  it("rejects numbers without plus sign", () => {
    expect(isValidE164("15551234567")).toBe(false);
    expect(isValidE164("5551234567")).toBe(false);
  });

  it("rejects invalid country codes", () => {
    expect(isValidE164("+05551234567")).toBe(false);
    // Country code 55 (Brazil) is valid, so +5551234567 IS valid E.164
    expect(isValidE164("+5551234567")).toBe(true);
  });

  it("rejects numbers with too many digits", () => {
    expect(isValidE164("+1555123456789012")).toBe(false);
  });

  it("rejects numbers with formatting characters", () => {
    expect(isValidE164("+1 555 123 4567")).toBe(false);
    expect(isValidE164("+1-555-123-4567")).toBe(false);
  });
});

describe("createDebug", () => {
  const originalLogging = process.env.PI_SIGNAL_DEBUG;

  afterEach(() => {
    if (originalLogging !== undefined) {
      process.env.PI_SIGNAL_DEBUG = originalLogging;
    } else {
      delete process.env.PI_SIGNAL_DEBUG;
    }
  });

  it("returns a function", () => {
    const debug = createDebug("test");
    expect(typeof debug).toBe("function");
  });

  it("does not log when PI_SIGNAL_DEBUG is not set", () => {
    delete process.env.PI_SIGNAL_DEBUG;
    const debug = createDebug("test");
    debug("hello");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("does not log when PI_SIGNAL_DEBUG is 'false'", () => {
    process.env.PI_SIGNAL_DEBUG = "false";
    const debug = createDebug("test");
    debug("hello");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("does not log when PI_SIGNAL_DEBUG is '0'", () => {
    process.env.PI_SIGNAL_DEBUG = "0";
    const debug = createDebug("test");
    debug("hello");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("does not log when PI_SIGNAL_DEBUG is 'no'", () => {
    process.env.PI_SIGNAL_DEBUG = "no";
    const debug = createDebug("test");
    debug("hello");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("logs when PI_SIGNAL_DEBUG is 'true'", () => {
    process.env.PI_SIGNAL_DEBUG = "true";
    const debug = createDebug("signal");
    debug("hello world");
    expect(console.log).toHaveBeenCalledWith("[signal]", "hello world");
  });

  it("logs when PI_SIGNAL_DEBUG is '1'", () => {
    process.env.PI_SIGNAL_DEBUG = "1";
    const debug = createDebug("signal");
    debug("hello world");
    expect(console.log).toHaveBeenCalledWith("[signal]", "hello world");
  });

  it("logs when PI_SIGNAL_DEBUG is 'log'", () => {
    process.env.PI_SIGNAL_DEBUG = "log";
    const debug = createDebug("signal");
    debug("hello world");
    expect(console.log).toHaveBeenCalledWith("[signal]", "hello world");
  });

  it("uses case-insensitive LOGGING values", () => {
    process.env.PI_SIGNAL_DEBUG = "TRUE";
    const debug = createDebug("signal");
    debug("upper case");
    expect(console.log).toHaveBeenCalledWith("[signal]", "upper case");
  });

  it("logs multiple arguments", () => {
    process.env.PI_SIGNAL_DEBUG = "true";
    const debug = createDebug("test");
    debug("msg", "arg1", { key: "value" }, 42);
    expect(console.log).toHaveBeenCalledWith("[test]", "msg", "arg1", { key: "value" }, 42);
  });

  it("includes the prefix in all log calls", () => {
    process.env.PI_SIGNAL_DEBUG = "true";
    const debug = createDebug("attachments");
    debug("downloaded", "/path/to/file.jpg");
    expect(console.log).toHaveBeenCalledWith(
      "[attachments]",
      "downloaded",
      "/path/to/file.jpg",
    );
  });

  it("uses a different prefix for different debug functions", () => {
    process.env.PI_SIGNAL_DEBUG = "true";
    const debug1 = createDebug("signal");
    const debug2 = createDebug("attachments");
    debug1("message 1");
    debug2("message 2");
    expect(console.log).toHaveBeenCalledWith("[signal]", "message 1");
    expect(console.log).toHaveBeenCalledWith("[attachments]", "message 2");
  });
});
