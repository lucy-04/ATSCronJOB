import type { Job } from "./types.js";

/** A global title filter: keep titles that hit an include term and no exclude term. */
export interface RoleFilter {
  include: string[];
  exclude: string[];
}

/** Lowercase; collapse runs of non-alphanumerics to single spaces; trim. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Word-boundary substring match. A title matches iff it contains at least one
 * include term and no exclude term, where a "term" must appear as whole words
 * (padding with spaces prevents e.g. "software engineer" matching inside
 * "software engineering manager", or "vp" matching inside "devpost").
 * An empty include list means "no filter" — everything matches.
 */
export function matchesRole(title: string, filter: RoleFilter): boolean {
  if (filter.include.length === 0) return true;
  const t = ` ${normalize(title)} `;
  const has = (kw: string): boolean => t.includes(` ${normalize(kw)} `);
  if (!filter.include.some(has)) return false;
  return !filter.exclude.some(has);
}

/** Keep only jobs whose title matches. Empty include ⇒ all jobs pass unchanged. */
export function filterJobs(jobs: Job[], filter: RoleFilter): Job[] {
  if (filter.include.length === 0) return jobs;
  return jobs.filter((j) => matchesRole(j.title, filter));
}
