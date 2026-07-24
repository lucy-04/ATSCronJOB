import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Target } from "./core/types.js";

// Phase 1: minimal load + shape check. Full zod validation of every field
// arrives in Phase 5; for now we only guard against a malformed file.
export function loadTargets(path = "targets.json"): Target[] {
  const abs = resolve(process.cwd(), path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Could not read/parse ${abs}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${abs} must contain a JSON array of targets`);
  }
  return parsed as Target[];
}
