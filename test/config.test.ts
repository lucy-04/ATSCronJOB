import { describe, it, expect } from "vitest";
import { loadRoleFilter } from "../src/config.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadRoleFilter", () => {
  it("returns empty filter when file is missing", () => {
    const result = loadRoleFilter("this-file-does-not-exist-12345-unique.json");
    expect(result).toEqual({ include: [], exclude: [] });
  });

  it("throws with 'Could not parse' message when JSON is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ats-roles-"));
    try {
      const p = join(dir, "malformed.json");
      writeFileSync(p, "{ not valid json", "utf8");
      expect(() => loadRoleFilter(p)).toThrow(/Could not parse/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
