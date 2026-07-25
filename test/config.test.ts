import { describe, it, expect, afterAll } from "vitest";
import { loadRoleFilter } from "../src/config.js";
import { writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

describe("loadRoleFilter", () => {
  it("returns empty filter when file is missing", () => {
    const result = loadRoleFilter("this-file-does-not-exist-12345-unique.json");
    expect(result).toEqual({ include: [], exclude: [] });
  });

  it("throws with 'Could not parse' message when JSON is malformed", () => {
    // Create a temporary file with invalid JSON
    const tmpDir = process.env.CLAUDE_JOB_DIR || process.cwd();
    const tmpPath = resolve(tmpDir, "tmp", `malformed-${Date.now()}.json`);
    const absPath = tmpPath;

    // Ensure tmp directory exists
    const tmpDirPath = resolve(tmpDir, "tmp");
    try {
      writeFileSync(absPath, "{ not valid json", "utf8");
      expect(() => loadRoleFilter(absPath)).toThrow(/Could not parse/);
    } finally {
      // Clean up
      rmSync(absPath, { force: true });
    }
  });
});
