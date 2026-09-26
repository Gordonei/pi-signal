import * as realFs from "node:fs";
import * as realPath from "node:path";
import * as realOs from "node:os";
import * as path from "node:path";

describe("attachments module", () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    // Create a real temp directory
    tmpDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), "pi-signal-test-"));

    // Set environment for attachments module
    process.env.PI_SIGNAL_ATTACHMENTS_DIR = tmpDir;
    process.env.PI_SIGNAL_MAX_ATTACHMENT_AGE_DAYS = "7";

    // Clear module cache to force reload with new env
    jest.resetModules();
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      realFs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Restore environment
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("PI_SIGNAL_")) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  describe("downloadAttachments", () => {
    it("returns empty array when no attachments key", async () => {
      const { downloadAttachments } = await import("../../extensions/attachments");
      const result = await downloadAttachments({});
      expect(result).toEqual([]);
    });

    it("returns empty array when attachments is not an array", async () => {
      const { downloadAttachments } = await import("../../extensions/attachments");
      const result = await downloadAttachments({ attachments: "not-an-array" });
      expect(result).toEqual([]);
    });

    it("returns empty array when attachments array is empty", async () => {
      const { downloadAttachments } = await import("../../extensions/attachments");
      const result = await downloadAttachments({ attachments: [] });
      expect(result).toEqual([]);
    });

    it("skips attachment objects with no url and no id", async () => {
      const { downloadAttachments } = await import("../../extensions/attachments");
      const attachments = [
        { something: "not an url or id" },
        {},
        null,
        undefined,
        "string",
      ];
      // Should not throw, should return empty array
      const result = await downloadAttachments({ attachments }, tmpDir);
      expect(result).toEqual([]);
    });
  });

  describe("cleanupAttachments", () => {
    it("does not crash with empty directory", () => {
      jest.resetModules();
      const { cleanupAttachments } = require("../../extensions/attachments");
      // Should not throw
      expect(() => cleanupAttachments(tmpDir)).not.toThrow();
    });
  });

  describe("getAttachmentInfo", () => {
    it("returns correct directory info", () => {
      jest.resetModules();
      const { getAttachmentInfo } = require("../../extensions/attachments");
      const info = getAttachmentInfo();

      expect(info.dir).toBe(tmpDir);
      expect(info.maxAgeDays).toBe(7);
    });

    it("reports enabled when directory exists", () => {
      jest.resetModules();
      // Ensure directory exists
      if (!realFs.existsSync(tmpDir)) {
        realFs.mkdirSync(tmpDir, { recursive: true });
      }
      const { getAttachmentInfo } = require("../../extensions/attachments");
      const info = getAttachmentInfo();
      expect(info.enabled).toBe(true);
    });
  });

  describe("ATTACHMENTS_DIR", () => {
    it("uses the environment variable for directory", () => {
      jest.resetModules();
      process.env.PI_SIGNAL_ATTACHMENTS_DIR = tmpDir;
      // @ts-ignore
      const { ATTACHMENTS_DIR } = require("../../extensions/attachments");
      expect(ATTACHMENTS_DIR).toBe(tmpDir);
    });

    it("uses default path when env var is not set", () => {
      jest.resetModules();
      delete process.env.PI_SIGNAL_ATTACHMENTS_DIR;
      // @ts-ignore
      const { ATTACHMENTS_DIR } = require("../../extensions/attachments");
      expect(ATTACHMENTS_DIR).toBe("/tmp/pi-signal/attachments");
    });
  });

  describe("MAX_ATTACHMENT_AGE_DAYS", () => {
    it("uses the environment variable for max age", () => {
      jest.resetModules();
      process.env.PI_SIGNAL_MAX_ATTACHMENT_AGE_DAYS = "30";
      const { cleanupAttachments, getAttachmentInfo } = require("../../extensions/attachments");
      const info = getAttachmentInfo();
      expect(info.maxAgeDays).toBe(30);
    });

    it("defaults to 7 days", () => {
      jest.resetModules();
      delete process.env.PI_SIGNAL_MAX_ATTACHMENT_AGE_DAYS;
      const { getAttachmentInfo } = require("../../extensions/attachments");
      const info = getAttachmentInfo();
      expect(info.maxAgeDays).toBe(7);
    });
  });
});
