import type { SimpleTarget, Target } from "../core/types.js";

/**
 * Narrow a Target to a SimpleTarget and return its `token`. The registry only
 * ever routes a target to its matching adapter, so this should never throw in
 * normal operation — it guards against a misconfigured registry.
 */
export function tokenOf(target: Target): string {
  if (target.ats === "workday") {
    throw new Error(`Expected a token-based ATS, got workday for "${target.company}"`);
  }
  return (target as SimpleTarget).token;
}

/**
 * Stable per-source key derived from the target — NOT the display `company`,
 * so renaming a company never resets its dedup history. Used as the state-store
 * partition key.
 */
export function sourceKeyOf(target: Target): string {
  if (target.ats === "workday") {
    return `${target.ats}:${target.tenant}:${target.site}`;
  }
  return `${target.ats}:${target.token}`;
}
