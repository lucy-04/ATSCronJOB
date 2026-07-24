# Phase 2 — SQLite State + Dedup — Design Spec

**Date:** 2026-07-24
**Status:** Approved, ready for implementation planning
**Scope:** Local dedup only. GitHub Actions cron + state-branch persistence is Phase 3.

## Goal

Make the poller report **only newly-posted roles** instead of re-reporting every
job on every run. Introduce a persistent state store, dedup fetched jobs against
it, and prune stale entries so genuinely re-posted roles surface again.

## Decisions (locked)

| Decision | Choice |
|---|---|
| First run against a source | **Seed silently** — record all current jobs, notify none. Keyed per source, so a company added later also seeds silently on first appearance. |
| Phase 2 scope | **Local dedup only.** GH Actions cron + persisting `state.db` to the orphan `state` branch is deferred to Phase 3. |
| Disappeared then reappearing job | **Prune & re-notify** — track `last_seen`, age out absent jobs after a grace window; a reappearing id counts as new. |
| Prune grace window | **14 days** (configurable). |

## Architecture

One new storage module plus a small refactor of the entrypoint to make the poll
loop testable, following the existing injectable-dependency pattern already used
for `HttpClient`.

### New / changed files

- **`src/core/state.ts`** *(new)* — `StateStore` interface + `createSqliteStore()`
  factory backed by `better-sqlite3`. Injectable: tests pass an in-memory DB
  (`:memory:`), mirroring the fake-`HttpClient` approach — no file, no network.
- **`src/core/poll.ts`** *(new)* — extract the per-target loop out of `index.ts`
  into a pure `poll({ targets, http, store, notifier })` function. Makes the whole
  flow unit-testable. This is the one targeted improvement to existing code.
- **`src/index.ts`** *(changed)* — trimmed to dependency wiring: build real
  `http`, `store`, `notifier`, `loadTargets()`, call `poll(...)`, then `store.close()`.

### Component boundaries

- `state.ts` — **what:** persist which (source, job_id) pairs have been seen and
  when; compute the new-job diff; prune stale rows. **How used:** `diffAndRecord`,
  `prune`, `close`. **Depends on:** `better-sqlite3`, `Job` type.
- `poll.ts` — **what:** orchestrate fetch → dedup → notify across all targets.
  **How used:** `poll(deps)`. **Depends on:** the adapter registry, `HttpClient`,
  `StateStore`, `Notifier` (all injected).

## Data model

```sql
CREATE TABLE IF NOT EXISTS seen_jobs (
  source     TEXT NOT NULL,   -- stable key, NOT display name
  job_id     TEXT NOT NULL,
  first_seen TEXT NOT NULL,   -- ISO-8601, set once on insert
  last_seen  TEXT NOT NULL,   -- ISO-8601, bumped every run the job is present
  PRIMARY KEY (source, job_id)
);
```

- `source` is a **stable** key derived from the target — **not** `company` — so
  renaming a company's display label never resets its dedup history:
  - Simple (token-based) targets: `` `${ats}:${token}` ``
  - Workday targets: `` `${ats}:${tenant}:${site}` ``
- A `sourceKeyOf(target: Target): string` helper computes this (lives in
  `state.ts` or `adapters/util.ts` — implementer's choice, keep it near the
  target-narrowing logic).

## Dedup algorithm — `diffAndRecord(source, jobs)`

Runs per source, per poll:

1. `isNewSource = (count of rows for source === 0)`
2. `existingIds = set of job_id currently stored for source`
3. `newJobs = isNewSource ? [] : jobs.filter(j => !existingIds.has(j.id))`
   — seed-silently falls out of step 1 for free.
4. Upsert **every** fetched job: `INSERT ... ON CONFLICT(source, job_id) DO UPDATE
   SET last_seen = :now`. On insert, `first_seen = last_seen = now`.
5. Return `newJobs`.

All writes for a single `diffAndRecord` call run inside one transaction.

## Prune & re-notify — `prune(graceDays)`

- Called **once per run** (not per source), after all sources are processed.
- Deletes rows where `last_seen < now - graceDays`.
- A job absent from the board ages out; if its id later reappears it is no longer
  in the DB, so it is counted as new and re-notified.
- The grace window (vs. pruning the instant a job is absent) prevents flapping
  from a transient board hiccup or pagination flake.
- Default `graceDays = 14`, configurable (constant/option, not hard-coded inline).
- Returns the number of rows removed (for a log line).

## StateStore interface

```ts
export interface StateStore {
  /** Record all fetched jobs for a source; return only the ones new to us. */
  diffAndRecord(source: string, jobs: Job[]): Job[];
  /** Remove jobs not seen within graceDays; return rows removed. */
  prune(graceDays: number): number;
  close(): void;
}

export interface SqliteStoreOptions {
  /** DB file path. Default "state.db". Pass ":memory:" in tests. */
  path?: string;
}

export function createSqliteStore(opts?: SqliteStoreOptions): StateStore;
```

- Default path `state.db` (already in `.gitignore`).
- `close()` is called by `index.ts` after `poll` completes.

## Poll loop — `poll(deps)`

```ts
export interface PollDeps {
  targets: Target[];
  http: HttpClient;
  store: StateStore;
  notifier: Notifier;
  graceDays?: number; // default 14
}

export async function poll(deps: PollDeps): Promise<void>;
```

Behavior (preserves current Phase 1 logging, but notifies only new jobs):

1. For each target: skip if no adapter registered (log, as today).
2. Fetch jobs via the adapter (per-target try/catch — one failure never aborts the run, as today).
3. `newJobs = store.diffAndRecord(sourceKeyOf(target), jobs)`.
4. Log `Company (ats): N job(s), M new`.
5. Collect `newJobs` (paired with target as `Notification`).
6. After the loop: `store.prune(graceDays)` (log rows removed), then `notifier.notifyBatch(found)`.

## Testing (vitest — first tests in the repo)

- **`test/state.test.ts`** (in-memory DB):
  - first run seeds silently → returns 0 new;
  - second run with one extra job → returns 1 new;
  - unchanged run → 0 new;
  - prune ages out an absent job, then the same id reappears → counted as new again;
  - `first_seen` is stable across runs; `last_seen` advances.
- **`test/poll.test.ts`**:
  - `poll()` with a fake `HttpClient` returning a recorded Greenhouse fixture, an
    in-memory store, and a capturing notifier;
  - asserts first run notifies nothing (seed), a later run with a new job notifies exactly that job.

Tests may control "now" via an injected clock or by writing rows with explicit
timestamps to exercise pruning deterministically (implementer's choice; keep it
simple — direct timestamp writes are acceptable).

## Out of scope (later phases)

- **Phase 3:** GitHub Actions cron; persist `state.db` to the orphan `state` branch.
- **Phase 5:** Zod validation of targets; HTTP retry/backoff on 429/5xx.
- Remaining adapters (lever, ashby, smartrecruiters, workable, workday); Telegram notifier.

## Success criteria

- Running `npm start` twice with an unchanged board reports jobs on neither run
  (first seeds, second finds nothing new).
- Adding one job to the board and re-running reports exactly that one job.
- `npm test` passes; `npm run typecheck` clean.
- No behavioral regression in per-target error isolation or console formatting.
