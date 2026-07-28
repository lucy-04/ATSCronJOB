# ATS Job Poller — Project Summary

> **Status: updated 2026-07-28.** This document reflects the current state of the
> project. It replaces the earlier Phase-1 snapshot.

## What it is

`ats-job-poller` is a small Node.js/TypeScript tool that **polls company Applicant
Tracking System (ATS) job boards on an hourly schedule, keeps only the roles
matching a title filter, remembers what it has already seen, and pushes genuinely
new roles to Telegram**. It runs as a GitHub Actions cron — no server to operate.

- **Runtime:** Node ≥ 20, ESM (`"type": "module"`), TypeScript 5.7 strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), run via `tsx` (no build step — `noEmit`).
- **Dependencies:** `better-sqlite3` (dedup state), `zod` (declared; validation not yet wired).
- **Dev/test:** `vitest` (68 tests across 11 files), `tsc --noEmit` for typechecking.
- **Repo:** git repo on GitHub (`lucy-04/ATSCronJOB`); production dedup state lives on an orphan `state` branch.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | `tsx src/index.ts` — run one poll cycle |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` |

## How it works (end to end)

`src/index.ts` runs one cycle:

1. **Load config** — `loadSources()` reads `sources.json` (the companies to poll); `loadRoleFilter()` reads `roles.json` (which titles to keep).
2. **Pick the notifier** — `chooseNotifier()` returns the **Telegram** notifier when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set, else the **console** notifier (local runs / CI without secrets).
3. **Poll** (`src/core/poll.ts`) — for each source: fetch via its adapter, apply the role filter (company sources only, before dedup), diff against the SQLite store, log a per-source summary, and collect the jobs new to us. Per-source failures are isolated — one bad board never aborts the run.
4. **Dedup + prune** (`src/core/state.ts`) — records seen jobs; re-notifies nothing already seen; prunes jobs gone for >14 days (scoped to sources that fetched OK).
5. **Notify** — the batch of new jobs is delivered in one operation (Telegram, chunked to the 4096-char limit; or console).

**Seed-silently:** a brand-new source's jobs are recorded without notifying on the first run, so adding companies never floods you — only genuinely new postings thereafter alert.

## Architecture / key files

```
src/
├── index.ts              # entrypoint: load → chooseNotifier → poll; guarded by isMain
├── config.ts             # loadSources(), loadRoleFilter() — read + shape-check JSON
├── core/
│   ├── types.ts          # Source/Job/Adapter/Notifier contracts (the design backbone)
│   ├── http.ts           # HttpClient factory: UA header, 15s timeout, JSON parse, HttpError
│   ├── state.ts          # createSqliteStore: diffAndRecord() dedup + prune() (WAL, checkpoint-on-close)
│   ├── poll.ts           # poll(): fetch → filter → dedup → prune → notify
│   └── filter.ts         # matchesRole()/filterJobs(): word-boundary title matching
├── adapters/
│   ├── index.ts          # registries: companyRegistry (by ATS) + queryRegistry (by provider)
│   ├── util.ts           # tokenOf(), sourceKeyOf() (stable dedup key), sourceLabel()
│   ├── greenhouse.ts     # ATS adapters — each ~45 lines, one normalize() → Job
│   ├── ashby.ts
│   ├── lever.ts
│   ├── smartrecruiters.ts
│   └── adzuna.ts         # query (aggregator) adapter — present but dormant (no query sources seeded)
└── notifiers/
    ├── console.ts        # consoleNotifier: sorted pretty-print (fallback)
    └── telegram.ts       # createTelegramNotifier: HTML, escaped, chunked to 4096
```

### The core contracts (`src/core/types.ts`)

- **`Source`** — discriminated on `kind`:
  - **`CompanySource`** (`kind:"company"`) — a specific company's board. Split into `SimpleSource` (token-based: greenhouse/lever/ashby/smartrecruiters/workable, carries `token`, plus optional `country` honoured by SmartRecruiters) and `WorkdaySource` (tenant/dc/site).
  - **`QuerySource`** (`kind:"query"`) — a cross-company title search via an aggregator (`provider:"adzuna"`, `query`/`where`/`country`). Supported by code, not currently used in `sources.json`.
- **`Job`** — normalized posting. `id` is the **dedup identity (not a timestamp)**, so a missing `postedAt` never blocks new-job detection. Optional `company`/`department`/`postedAt`.
- **`CompanyAdapter` / `QueryAdapter`** — `fetchJobs(source, http)`, dispatched by `ats`/`provider`.
- **`Notifier`** — `notifyBatch(items)`, batched so a burst of new roles is one delivery.
- **`HttpClient`** — injected `getJson`/`postJson` so every adapter and notifier is testable offline with a fake.

## Adapters & coverage

Four **company** ATS adapters are live; each new ATS is a self-contained file plus one registry line (no type/engine changes), because the dedup/filter/prune engine depends only on `Job.id`.

| ATS | API (public, key-less) | Notes |
|---|---|---|
| **Greenhouse** | `boards-api.greenhouse.io/v1/boards/{token}/jobs` | Most common; token = board slug |
| **Ashby** | `api.ashbyhq.com/posting-api/job-board/{token}` | Where most AI labs post |
| **Lever** | `api.lever.co/v0/postings/{token}?mode=json` | Bare array; title field is `text` |
| **SmartRecruiters** | `api.smartrecruiters.com/v1/companies/{token}/postings?limit=100` | Case-sensitive token; optional `&country=in`; page-1 only |

**`sources.json` currently has 105 companies** — 60 Greenhouse, 29 Ashby, 8 Lever, 8 SmartRecruiters — spanning big tech, fintech, AI labs (OpenAI, Anthropic, xAI, Cursor, Cognition, Sarvam AI, …), and India-hiring companies (PhonePe, Meesho, CRED, Groww, Sarvam AI; Bosch/Continental India via the SmartRecruiters `country=in` filter).

The **Adzuna** query adapter (cross-company aggregator search) exists but is dormant — no query sources are seeded (deprioritized as noisy).

## Configuration

- **`sources.json`** — the companies to poll (`Source[]`; `sources.example.json` shows the shapes). Committed config.
- **`roles.json`** — the title filter: `include` (a title must contain one, word-boundary, case/punctuation-insensitive) and `exclude` (and none of these). Current include: software / backend / full stack / fullstack / ai engineer, agentic ai. Exclude: manager, director, vp, vice president, head of, intern, sales, lead, principal, senior, sr. Missing/empty file = no filtering (match all). `roles.example.json` mirrors it.

## Deployment (the cron)

`.github/workflows/poll.yml` runs hourly: checks out code + the `state` branch, runs `npm start` (with `STATE_DB_PATH` pointing at the checked-out `state.db`), then persists the updated `state.db` back to the orphan `state` branch via force-with-lease. Secrets injected into the run step: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (active), and `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` (only needed if query sources are used). Setup details — including creating the Telegram bot and getting a chat id — are in `docs/deployment.md`.

## Testing

68 vitest tests, all offline (fake `HttpClient`, `:memory:` SQLite, injectable clock): per-adapter normalization + edge cases, the role filter, config loaders, the dedup/prune store (incl. WAL checkpoint), the poll loop (filter + seed-silently + scoped prune + back-compat), and both notifiers.

## Design/roadmap docs

- `docs/deployment.md` — bootstrap, ATS reference, Telegram setup, role filter.
- `docs/phase-2-explained.md` — from-scratch walkthrough of the dedup engine.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — the per-phase spec → plan history (dedup, cron, hybrid sources, role filter, each adapter, Telegram, SmartRecruiters country).

## Known limitations & next steps

- **Delivery reliability:** jobs are recorded before Telegram delivery. In the cron this is at-least-once (a failed send fails the run, so state isn't persisted and the batch retries next hour); local `npm start` runs are at-most-once. A `record-after-notify` change (tracked in a `poll.ts` comment) would make local runs at-least-once too.
- **SmartRecruiters** fetches only the first 100 postings per company (no pagination).
- **No location filter** — India focus currently relies on India-HQ companies + the SmartRecruiters `country` filter. Companies on closed ATSes (Darwinbox — bot-protected, ruled out) are unreachable directly; an aggregator (Adzuna `country=in`) is the only route to those.
- **zod validation** of `sources.json`/`roles.json` is declared but not yet wired (currently a shape check).
- Minor: `byTierThenLabel` is duplicated in `console.ts` and `telegram.ts` (candidate to hoist into `util.ts`).
