import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Source } from "./core/types.js";
import type { RoleFilter } from "./core/filter.js";

/**
 * Load sources from JSON. Entries without an explicit `kind` default to
 * "company" so the pre-hybrid targets.json shape still parses. Full zod
 * validation arrives later; for now we only guard against a malformed file.
 */
export function loadSources(path = "sources.json"): Source[] {
  const abs = resolve(process.cwd(), path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Could not read/parse ${abs}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${abs} must contain a JSON array of sources`);
  }
  return parsed.map((entry) => {
    const e = entry as Record<string, unknown>;
    return (e.kind === undefined ? { ...e, kind: "company" } : e) as unknown as Source;
  });
}

/**
 * Load the role filter. A MISSING file means "no filtering" (returns empty
 * include/exclude); a present-but-malformed file throws. Full zod validation
 * is a later phase.
 */
export function loadRoleFilter(path = "roles.json"): RoleFilter {
  const abs = resolve(process.cwd(), path);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return { include: [], exclude: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse ${abs}: ${(err as Error).message}`);
  }
  const p = (parsed ?? {}) as Partial<RoleFilter>;
  return {
    include: Array.isArray(p.include) ? p.include.map(String) : [],
    exclude: Array.isArray(p.exclude) ? p.exclude.map(String) : [],
  };
}
