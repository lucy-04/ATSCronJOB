# ATS Job Poller — Project Summary

> Generated 2026-07-24 by reading the codebase. The previous Claude Code session's
> plan-mode notes were lost, so this reconstructs the project's intent and roadmap
> from the source itself (which is heavily commented with phase markers).

## What it is

`ats-job-poller` (package name in `package.json`) is a small Node.js/TypeScript
tool that **polls company Applicant Tracking System (ATS) endpoints and reports
newly-posted job roles**. The end goal (per the package description) is to push
new roles to **Telegram**, but the project is currently at an early phase that
only prints to the console.

- **Runtime:** Node ≥ 20, ESM (`"type": "module"`)
- **Language:** TypeScript 5.7, strict mode, run directly via `tsx` (no build step yet — `noEmit`)
- **Dependencies:** `better-sqlite3` (state/dedup store, not wired up yet), `zod` (validation, not wired up yet)
- **Dev/test:** `vitest`, `tsc --noEmit` for typechecking
- **Git:** This working copy is **not** a git repo currently (no `.git`). Note: `.gitignore` mentions production state lives on an orphan `state` branch, so a git remote/history exists elsewhere.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | `tsx src/index.ts` — run the poller once |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` (no tests exist in the tree yet) |

## How it works today (Phase 1)

`src/index.ts` is the entrypoint. On each run it:

1. **Loads targets** from `targets.json` (`src/config.ts`) — currently just a shape check, not full validation.
2. For each target, looks up an **adapter** by its `ats` field via the registry (`src/adapters/index.ts`).
3. Skips any ATS with no adapter implemented yet (prints a "not implemented" line).
4. Calls `adapter.fetchJobs(target, http)` to hit the ATS API and get normalized `Job[]`.
5. Collects all jobs and hands them to the **console notifier** (`src/notifiers/console.ts`), which sorts by tier then company and prints them.

**No persistence, no dedup, no Telegram yet** — every run reports *all* jobs, not just new ones. Those come in later phases.

## Architecture / key files

```
src/
├── index.ts              # Phase 1 entrypoint: load → fetch → print
├── config.ts             # loadTargets(): read + shape-check targets.json
├── core/
│   ├── types.ts          # Shared contracts (the stable core of the design)
│   └── http.ts           # HttpClient factory: UA header, timeout, JSON parse
├── adapters/
│   ├── index.ts          # Adapter registry keyed by ATS
│   ├── greenhouse.ts     # The ONE implemented adapter so far
│   └── util.ts           # tokenOf(): narrow Target → SimpleTarget token
└── notifiers/
    └── console.ts        # consoleNotifier: sorted pretty-print (also the fallback notifier)
```

### The core contracts (`src/core/types.ts`)

This file is the design's backbone — everything depends on it:

- **`Ats`** — union of supported systems: `greenhouse | lever | ashby | smartrecruiters | workable | workday`.
- **`Job`** — normalized posting across every ATS. Important detail: `id` is the **dedup identity (not a timestamp)**, so a missing `postedAt` never blocks new-job detection.
- **`Target`** — discriminated union on `ats`:
  - `SimpleTarget` — token/slug-based ATSes (greenhouse, lever, ashby, smartrecruiters, workable), carries a single `token`.
  - `WorkdayTarget` — needs `tenant` + `dc` (the `wdN` shard) + `site`, discovered via DevTools.
  - `tier?` (default 3) is label/sort-order only.
- **`HttpClient`** — minimal injected HTTP surface (`getJson`/`postJson`) so tests can supply a fake fixture instead of mocking global fetch or hitting the network.
- **`Adapter`** — `{ ats, fetchJobs(target, http) }`.
- **`Notifier`** — `notifyBatch(items)`, deliberately batched so a burst of new roles is throttled as one operation.

### HTTP client (`src/core/http.ts`)

Factory returning an `HttpClient` with an honest identifiable User-Agent, a 15s default timeout (via `AbortController`), and JSON parsing. Throws a typed `HttpError` on non-2xx. Retry/backoff on 429/5xx is explicitly deferred to Phase 5.

### Greenhouse adapter (`src/adapters/greenhouse.ts`)

The only working adapter. Hits `GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` and normalizes each job (id→string, location fallback to "Unspecified", optional department/postedAt).

## Configuration (`targets.json`)

An array of target objects. `targets.example.json` shows the full range of ATS types; the live `targets.json` currently has just two, both Greenhouse:

```json
[
  { "company": "Stripe",  "ats": "greenhouse", "token": "stripe", "tier": 1 },
  { "company": "Airbnb",  "ats": "greenhouse", "token": "airbnb", "tier": 2 }
]
```

## Reconstructed roadmap (from in-code phase markers)

The source comments repeatedly reference numbered phases. Inferred plan:

- **Phase 1 (current):** load targets → fetch supported ATSes → print to console. No state/dedup/Telegram. ✅ implemented for Greenhouse.
- **Phase 2+:** Add **state + dedup** (the `better-sqlite3` dependency — `state.db`, ignored in git, lives on an orphan `state` branch in production) so only *newly-posted* roles are reported.
- **Later phases:** Implement the remaining adapters — **lever, ashby, smartrecruiters, workable, workday** — registering each in `src/adapters/index.ts`.
- **Phase 5:** Full **zod validation** of every target field (replacing the shape-check in `config.ts`), plus **retry/backoff on 429/5xx** in the HTTP client.
- **Eventually:** A **Telegram notifier** (per the package description) alongside/replacing the console one. The `Notifier` interface and batching design already anticipate this.

## Current state & gaps

- Only **1 of 6** ATS adapters implemented (Greenhouse).
- **No tests** yet despite vitest being configured and the `HttpClient` being designed for injectable fakes.
- **No dedup/state** — reruns re-report everything.
- **No Telegram notifier** — only console output exists.
- **Not currently a git repo** in this directory (state branch / remote history is external).
- `config.ts` does only a shape check; full validation is pending (Phase 5).

## Suggested next step

If you're resuming the lost session, the natural continuation is **Phase 2: wiring up `better-sqlite3` state + dedup** so the poller reports only new roles — that's the prerequisite for any useful notifier (Telegram). Adding the first vitest test against the Greenhouse adapter (using a fake `HttpClient`) would also be a low-risk way to lock in current behavior first.
