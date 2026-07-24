import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Source } from "./core/types.js";

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
