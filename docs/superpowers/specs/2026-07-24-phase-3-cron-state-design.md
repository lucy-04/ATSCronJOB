# Phase 3 — Scheduled Cron + Persistent State — Design Spec

**Date:** 2026-07-24
**Status:** Approved, ready for implementation planning
**Scope:** GitHub Actions cron + `state.db` persistence on an orphan `state` branch, plus the prune-on-fetch-failure fix. Telegram notifier is OUT of scope (Phase 4).

## Goal

Run the poller automatically on a schedule (hourly) in GitHub Actions, carrying
the dedup `state.db` between otherwise-stateless runs via a dedicated orphan
`state` branch, so new roles are detected over time without any manual runs. Also
fix the known prune-on-fetch-failure edge case, which becomes routine under an
unattended schedule.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Phase 3 scope | Cron + state persistence only. Telegram deferred to Phase 4. New jobs are logged to the Actions run log for now. |
| Schedule cadence | **Hourly** — `cron: '0 * * * *'`, plus `workflow_dispatch` for manual runs. |
| State persistence | Orphan **`state`** branch holding only `state.db`; `main` holds code and never contains `state.db` (already gitignored). |
| `state` branch history | Kept **flat**: each run `commit --amend` + force-push, so the branch stays a single ever-updated commit and the repo never bloats. |
| Prune-on-fetch-failure | **Fixed now**: only prune sources whose fetch succeeded this run. |

## Background: why this is non-trivial

GitHub Actions runners are ephemeral — each run starts on a fresh machine with no
disk state from prior runs. Dedup depends entirely on `state.db` surviving between
runs. The persistence mechanism is therefore the heart of this phase: `state.db`
is stored in git on an orphan `state` branch (no shared history with `main`), and
each run reads the prior copy and writes the updated copy back.

## Architecture — one scheduled run

```
GitHub Actions runner (fresh machine, hourly):
  1. actions/checkout@v4                      → repo code (main) at ./
  2. actions/checkout@v4 (ref: state,         → prior state.db at ./state-data/
     path: state-data)
  3. actions/setup-node@v4 (node 20) + npm ci
  4. STATE_DB_PATH=state-data/state.db npm start
       → read prior state, fetch boards, dedup, write updated state.db,
         log new jobs to the run log
  5. commit --amend the updated state-data/state.db onto the state branch,
     force-push (only if the DB changed)
```

The two independent checkouts give the run both the code and the prior state side
by side. Step 5 pushes updated state so the next run's step 2 picks it up.

## Component changes

### New: `.github/workflows/poll.yml`

- **Triggers:** `schedule: - cron: '0 * * * *'` and `workflow_dispatch:`.
- **Permissions:** `contents: write` (so the default `GITHUB_TOKEN` can push to
  the `state` branch).
- **Concurrency:** a `concurrency` group (e.g. `group: poll`,
  `cancel-in-progress: false`) so overlapping runs never race on the `state`
  branch push.
- **Job (`ubuntu-latest`):**
  1. Checkout `main` (default checkout).
  2. Checkout `state` branch into `state-data/` (`ref: state`, `path: state-data`,
     `persist-credentials: true`). The `state` branch is assumed to exist
     (bootstrapped once — see Setup).
  3. `actions/setup-node@v4` with `node-version: 20` and `cache: npm`; `npm ci`.
  4. Run the poller: `STATE_DB_PATH=state-data/state.db npm start`.
  5. Persist step (bash): `cd state-data`; if `git status --porcelain` shows a
     change to `state.db`, configure `github-actions[bot]` identity, `git add
     state.db`, `git commit --amend --no-edit`, and `git push --force-with-lease
     origin state`. If no change, do nothing. (The bootstrap's initial commit
     always exists as the amend target, so every run amends that single commit —
     no special first-run case, and the branch never accumulates history.)
- **Commit message:** `chore(state): update dedup state` (the branch is
  machine-only; the message is cosmetic since history is squashed).

### Changed: `src/index.ts`

Read the DB path from an env var so CI can point at the checked-out state file
while local runs are unchanged:

```ts
const store = createSqliteStore({ path: process.env.STATE_DB_PATH || undefined });
```

`undefined` falls through to the store's existing `"state.db"` default. No other
change to the entrypoint.

### Changed: `src/core/state.ts`

1. **WAL checkpoint on close.** `close()` runs `PRAGMA wal_checkpoint(TRUNCATE)`
   before `db.close()`, guaranteeing all WAL writes are folded into `state.db` and
   the `-wal`/`-shm` side files are emptied — so the committed `state.db` is always
   complete. (We commit only `state.db`, never the side files.)
2. **Prune scoping.** Signature changes:
   `prune(graceDays: number, sources: string[]): number`.
   - If `sources` is empty, prune nothing (return 0).
   - Else `DELETE FROM seen_jobs WHERE source IN (<placeholders>) AND last_seen <
     :cutoff`, cutoff computed from the injectable clock as before.
   - Rationale: a source absent from `sources` (its fetch failed this run) must
     never have its jobs aged out — we cannot distinguish "role gone" from "board
     unreachable."

### Changed: `src/core/poll.ts`

- Collect `okSources: string[]` — push `sourceKeyOf(target)` after a **successful**
  `diffAndRecord`. A target whose fetch/dedup throws is caught (as today) and its
  source is NOT added.
- After the loop: `store.prune(graceDays, okSources)` (was `store.prune(graceDays)`).
- All other behavior (per-target error isolation, log lines, new-jobs-only
  notification, single post-loop prune) is unchanged.

### Changed: tests

- **`test/state.test.ts`:** update existing `prune` tests to the new
  `prune(graceDays, sources)` signature (pass the relevant source list). Add a
  test: a source NOT in the `sources` argument keeps its stale rows (not pruned);
  a source IN the argument prunes as before. Empty `sources` prunes nothing.
- **`test/poll.test.ts`:** add a test where one target's `fetchJobs` throws and a
  second succeeds; assert the failed source's previously-stored jobs are NOT
  pruned (i.e. `poll` passed only the healthy source to `prune`), while the run
  still completes and notifies for the healthy source. Use the injectable clock so
  the failed source's rows are old enough that they *would* have been pruned under
  the old global behavior.

## Setup (one-time, manual)

Bootstrap the orphan `state` branch before the workflow first runs (it holds an
empty initial commit; the first scheduled run writes the real `state.db`):

```bash
git checkout --orphan state
git rm -rf .
git commit --allow-empty -m "Initialize state branch"
git push -u origin state
git checkout main
```

Also: ensure GitHub Actions is enabled for the repo (default on new repos), and
that workflow write permissions are allowed (Settings → Actions → General →
Workflow permissions → Read and write). No secrets are required this phase
(no Telegram).

## State-branch persistence details

- **WAL side files** (`state.db-wal`, `state.db-shm`) are never committed — the
  checkpoint-on-close (above) ensures `state.db` alone is complete. Add them to a
  `.gitignore` on the `state` branch as defense-in-depth (optional; the plan will
  decide). `main`'s `.gitignore` already ignores all three on `main`.
- **Flat history:** the persist step amends the single state commit and
  force-pushes with `--force-with-lease` (safer than `--force`: it refuses if the
  remote moved unexpectedly, guarding against the rare concurrent-run race the
  concurrency group already prevents).
- **First run:** if the `state` branch has only the empty init commit (no `state.db`
  yet), step 2's checkout yields an empty `state-data/`; the poller creates a fresh
  `state.db` there (seed-silently for every source), and the persist step makes the
  first real state commit.

## Out of scope (later phases)

- **Phase 4:** Telegram notifier (bot token + chat id as GitHub secrets).
- Remaining ATS adapters (lever, ashby, smartrecruiters, workable, workday).
- Zod validation of targets; HTTP retry/backoff (roadmap Phase 5).

## Success criteria

- `npm test` passes (updated prune tests + new poll test); `npm run typecheck` clean.
- Local `npm start` still works with no env var set (defaults to `./state.db`),
  and honors `STATE_DB_PATH` when set.
- A `workflow_dispatch` run: first run seeds silently (0 new, logs "No new jobs.")
  and commits an initial `state.db` to the `state` branch; a second run against
  unchanged boards reports 0 new and leaves the `state` branch a single commit
  (amended), not a growing history.
- A run where a target's fetch fails logs the failure, still completes, and does
  NOT prune the failed source's stored jobs.
- `state.db` never appears on `main`.
