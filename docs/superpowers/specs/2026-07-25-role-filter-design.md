# Phase 4 — Role Filter on Company Boards + Seed Config — Design Spec

**Date:** 2026-07-25
**Status:** Approved, ready for implementation planning
**Scope:** A global title/role filter applied to company-source jobs, plus a seeded `sources.json` (curated AI/tech Greenhouse companies) and a `roles.json` filter config. No Adzuna changes; query sources unaffected.

## Goal

Make company-board polling useful for a focused job hunt: poll a seeded list of
target companies, but only surface (and only track state for) jobs whose title
matches the user's preferred roles — not every job on the board.

## Decisions (locked)

| Decision | Choice |
|---|---|
| What "seed roles" means | A **title filter on company sources** (not Adzuna query sources — the user found Adzuna weak). |
| Include roles | Software Engineer, Backend Engineer, Full Stack Engineer, AI Engineer, Agentic AI. |
| Exclude terms | `manager, director, vp, vice president, head of, intern, sales, lead, principal, senior` (user wants non-senior IC roles). "Staff" intentionally NOT excluded. |
| Match semantics | Case- and punctuation-insensitive substring; matches if title contains ANY include term AND NO exclude term. |
| Filter scope | Applied to **company sources only**, BEFORE dedup. Query sources are self-scoped by their query and are left unfiltered. |
| Config layout | `sources.json` = where to look (Source[]); new `roles.json` = what to keep (`{include, exclude}`). One purpose per file. |
| Company seed | ~15–20 AI/tech companies known to use Greenhouse, best-effort board tokens, "verify on first run" (poll already logs per-company failures). |

## Matching

Normalize both the job title and each keyword by lowercasing and collapsing any
run of non-alphanumeric characters to a single space, then trimming. A job's
title **matches** the filter iff:

- it contains at least one **include** keyword as a substring, AND
- it contains no **exclude** keyword as a substring.

Punctuation-insensitivity means `Full-Stack Engineer` → `full stack engineer`
(matches the `full stack engineer` include) and `Fullstack Engineer` →
`fullstack engineer` (matches a `fullstack engineer` include variant). The
include list therefore seeds both `full stack engineer` and `fullstack engineer`.

Rationale for the exclude list: `Software Engineer` is a substring of
`Software Engineering Manager`, so excludes are required to avoid over-matching
into management/sales/senior titles.

## Config shapes

`roles.json` (new):
```json
{
  "include": ["software engineer", "backend engineer", "full stack engineer", "fullstack engineer", "ai engineer", "agentic ai"],
  "exclude": ["manager", "director", "vp", "vice president", "head of", "intern", "sales", "lead", "principal", "senior"]
}
```

`sources.json` (reseeded): a `Source[]` of ~15–20 `{ "kind":"company", "company", "ats":"greenhouse", "token", "tier" }` entries. Tokens are best-effort; wrong ones surface as `! <Company> failed: … 404 …` on the first run and get corrected.

## Architecture

The dedup `StateStore`, prune, `Notifier`, config-for-sources, and the cron
workflow are all reused unchanged. New/changed pieces:

- **`src/core/filter.ts`** *(new)* — `RoleFilter` type + `matchesRole(title, filter): boolean` + `filterJobs(jobs, filter): Job[]`. Pure, no I/O.
- **`src/config.ts`** — add `loadRoleFilter(path = "roles.json"): RoleFilter` (shape-check like `loadSources`).
- **`src/core/poll.ts`** — `PollDeps` gains optional `roleFilter?: RoleFilter`. After fetching a **company** source's jobs, apply `filterJobs` before `diffAndRecord`. Query sources and the summary/log lines are otherwise unchanged. When no filter is provided, behavior is identical to today (no filtering).
- **`src/index.ts`** — load `roles.json` via `loadRoleFilter()` and pass it to `poll`.
- **`roles.json` + `roles.example.json`** *(new)* — the filter config.
- **`sources.json`** — reseeded with the curated company list.

### Why filter before dedup

Filtering before `diffAndRecord` means the state store only ever records jobs the
user would be notified about. Consequence (acceptable/desirable): later broadening
the include list surfaces already-existing matching jobs as "new," since they were
never seeded.

## Testing

- **`test/filter.test.ts`** — `matchesRole`/`filterJobs`: include match (incl.
  seniority-prefixed titles like "Senior Backend Engineer" → excluded by "senior");
  exclude wins over include ("Software Engineering Manager" → dropped); punctuation
  variants ("Full-Stack", "Fullstack"); "Agentic AI" match; a clearly-unrelated
  title ("Account Executive") dropped.
- **`test/poll.test.ts`** — a company source whose board returns a mix of matching
  and non-matching titles: assert only matching jobs are notified, and that a
  non-matching job is NOT recorded (i.e. it would notify if the filter later
  included it). A poll with no `roleFilter` still notifies everything (back-compat).
- Config loader test for `loadRoleFilter` shape-check (optional, mirror
  `loadSources`).

## Out of scope (later phases)

- More ATS adapters (to seed non-Greenhouse companies).
- Telegram notifier; zod validation of `roles.json`/`sources.json`.
- Per-source role overrides (the filter is global for now).

## Success criteria

- `npm test` green; `npm run typecheck` clean.
- With `roles.json` present, a local `npm start` reports only matching-title jobs
  from company boards (first run seeds them silently, as always).
- **Empty/absent filter = no filtering (match all).** If `roleFilter` is not passed,
  OR its `include` list is empty, `filterJobs` returns all jobs unchanged — so a
  missing/empty `roles.json` preserves today's behavior exactly (never filters
  everything out by accident).
- Wrong company tokens surface as per-company failures on the first run without
  aborting the run.
