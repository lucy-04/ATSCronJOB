import type { CompanySource, Source } from "../core/types.js";

/** Return the `token` of a token-based company source. */
export function tokenOf(source: CompanySource): string {
  if (source.ats === "workday") {
    throw new Error(`Expected a token-based ATS, got workday for "${source.company}"`);
  }
  return source.token;
}

/** Lowercase, collapse non-alphanumerics to single dashes, trim dashes. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Stable per-source key for dedup — NOT the display label, so renaming a
 * company or a query nickname never resets its dedup history.
 */
export function sourceKeyOf(source: Source): string {
  if (source.kind === "query") {
    return `${source.provider}:${slug(source.query)}|${slug(source.where)}|${source.country.toLowerCase()}`;
  }
  if (source.ats === "workday") {
    return `${source.ats}:${source.tenant}:${source.site}`;
  }
  const key = `${source.ats}:${source.token}`;
  return source.country ? `${key}:${source.country.toLowerCase()}` : key;
}

/** Display name shown in notifications. */
export function sourceLabel(source: Source): string {
  return source.kind === "query" ? source.label : source.company;
}
