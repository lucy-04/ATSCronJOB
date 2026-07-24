# Phase 2 — SQLite State + Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the poller report only newly-posted roles by persisting seen jobs in SQLite, deduping each run against that state, and pruning stale entries so reposted roles resurface.

**Architecture:** A new injectable `StateStore` (SQLite via `better-sqlite3`, `:memory:` in tests) holds seen jobs and a `sources` registry. The per-target loop is extracted from `index.ts` into a pure, testable `poll()` function that fetches, diffs against the store, prunes, and notifies. `index.ts` shrinks to dependency wiring.

**Tech Stack:** TypeScript (ESM, strict), `better-sqlite3`, `vitest`, `tsx`.

## Global Constraints

- Node >= 20; ESM (`"type": "module"`) — all relative imports use `.js` extensions.
- `verbatimModuleSyntax` on: use `import type { ... }` for type-only imports.
- Dependencies limited to what's already in `package.json` (`better-sqlite3`, `zod`); no new deps.
- Injectable-dependency pattern: no global-fetch mocking, no live network, no real DB file in tests (use `:memory:`).
- Preserve Phase 1 behavior: per-target try/catch isolation (one failure never aborts the run) and existing console skip/format lines.
- Seed silently: a source's first-ever run records all jobs and notifies none.
- Prune grace window default: 14 days, configurable (named constant/option, never hard-coded inline at the call site).
- `source` key is stable and derived from the target, never the display `company`.

---

### Task 1: `sourceKeyOf` helper

**Files:**
- Modify: `src/adapters/util.ts`
- Test: `test/util.test.ts` (create)

**Interfaces:**
- Consumes: `Target`, `SimpleTarget`, `WorkdayTarget` from `src/core/types.js`.
- Produces: `sourceKeyOf(target: Target): string` — stable per-source key. Simple targets → `` `${ats}:${token}` ``; Workday → `` `${ats}:${tenant}:${site}` ``.

- [ ] **Step 1: Write the failing test**

Create `test/util.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sourceKeyOf } from "../src/adapters/util.js";
import type { Target } from "../src/core/types.js";

describe("sourceKeyOf", () => {
  it("keys a token-based target by ats and token", () => {
    const t: Target = { company: "Acme", ats: "greenhouse", token: "acme" };
    expect(sourceKeyOf(t)).toBe("greenhouse:acme");
  });

  it("keys a workday target by ats, tenant, and site", () => {
    const t: Target = { company: "Big Co", ats: "workday", tenant: "bigco", dc: "wd1", site: "External" };
    expect(sourceKeyOf(t)).toBe("workday:bigco:External");
  });

  it("is independent of the display company name", () => {
    const a: Target = { company: "Old Name", ats: "greenhouse", token: "acme" };
    const b: Target = { company: "New Name", ats: "greenhouse", token: "acme" };
    expect(sourceKeyOf(a)).toBe(sourceKeyOf(b));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/util.test.ts`
Expected: FAIL — `sourceKeyOf` is not exported from `../src/adapters/util.js`.

- [ ] **Step 3: Add the implementation**

Append to `src/adapters/util.ts`:

```ts
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
```

(The existing `import type { SimpleTarget, Target } from "../core/types.js";` already imports `Target`; leave it as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/util.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/util.ts test/util.test.ts
git commit -m "feat: add sourceKeyOf for stable per-source dedup keys"
```

---

### Task 2: `createSqliteStore` + `diffAndRecord`

**Files:**
- Create: `src/core/state.ts`
- Test: `test/state.test.ts` (create)

**Interfaces:**
- Consumes: `Job` from `src/core/types.js`; `better-sqlite3` default export.
- Produces:
  - `interface StateStore { diffAndRecord(source: string, jobs: Job[]): Job[]; prune(graceDays: number): number; close(): void; }`
  - `interface SqliteStoreOptions { path?: string; now?: () => number; }`
  - `createSqliteStore(opts?: SqliteStoreOptions): StateStore`
  - `diffAndRecord` records all jobs for `source` and returns only those new to us; a source's first-ever call seeds silently (returns `[]`). `prune` is implemented in Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSqliteStore } from "../src/core/state.js";
import type { Job } from "../src/core/types.js";

function job(id: string): Job {
  return { id, title: `Job ${id}`, url: `https://x/${id}`, location: "Remote" };
}

describe("diffAndRecord", () => {
  it("seeds silently on a source's first run", () => {
    const store = createSqliteStore({ path: ":memory:" });
    expect(store.diffAndRecord("gh:acme", [job("1"), job("2")])).toEqual([]);
    store.close();
  });

  it("detects a newly-added job on a later run", () => {
    const store = createSqliteStore({ path: ":memory:" });
    store.diffAndRecord("gh:acme", [job("1"), job("2")]);
    const found = store.diffAndRecord("gh:acme", [job("1"), job("2"), job("3")]);
    expect(found.map((j) => j.id)).toEqual(["3"]);
    store.close();
  });

  it("returns nothing when the board is unchanged", () => {
    const store = createSqliteStore({ path: ":memory:" });
    store.diffAndRecord("gh:acme", [job("1")]);
    expect(store.diffAndRecord("gh:acme", [job("1")])).toEqual([]);
    store.close();
  });

  it("tracks each source independently", () => {
    const store = createSqliteStore({ path: ":memory:" });
    store.diffAndRecord("gh:acme", [job("1")]);          // acme seeded
    const found = store.diffAndRecord("gh:other", [job("1")]); // other's first run
    expect(found).toEqual([]);                            // seeded, not "already seen"
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL — cannot find module `../src/core/state.js`.

- [ ] **Step 3: Write the implementation**

Create `src/core/state.ts`:

```ts
import Database from "better-sqlite3";
import type { Job } from "./types.js";

/** Persistent record of which jobs we've already seen, for dedup. */
export interface StateStore {
  /** Record all fetched jobs for a source; return only the ones new to us. */
  diffAndRecord(source: string, jobs: Job[]): Job[];
  /** Remove jobs whose last_seen is older than graceDays; return rows removed. */
  prune(graceDays: number): number;
  close(): void;
}

export interface SqliteStoreOptions {
  /** DB file path. Default "state.db". Pass ":memory:" in tests. */
  path?: string;
  /** Epoch-ms clock, injectable for deterministic tests. Default Date.now. */
  now?: () => number;
}

const DAY_MS = 86_400_000;

export function createSqliteStore(opts: SqliteStoreOptions = {}): StateStore {
  const db = new Database(opts.path ?? "state.db");
  const now = opts.now ?? Date.now;

  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      source     TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seen_jobs (
      source     TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      PRIMARY KEY (source, job_id)
    );
  `);

  const sourceExists = db.prepare(`SELECT 1 FROM sources WHERE source = ?`);
  const insertSource = db.prepare(
    `INSERT INTO sources (source, first_seen) VALUES (@source, @now)`,
  );
  const selectIds = db.prepare(`SELECT job_id FROM seen_jobs WHERE source = ?`);
  const upsert = db.prepare(`
    INSERT INTO seen_jobs (source, job_id, first_seen, last_seen)
    VALUES (@source, @jobId, @now, @now)
    ON CONFLICT(source, job_id) DO UPDATE SET last_seen = @now
  `);
  const deleteStale = db.prepare(`DELETE FROM seen_jobs WHERE last_seen < @cutoff`);

  return {
    diffAndRecord(source: string, jobs: Job[]): Job[] {
      const nowIso = new Date(now()).toISOString();
      // "New source" is tracked in `sources`, NOT by row count — so a source
      // pruned down to zero jobs is still known, and reappearing jobs re-notify.
      const isNewSource = sourceExists.get(source) === undefined;
      if (isNewSource) insertSource.run({ source, now: nowIso });

      const existing = new Set(
        (selectIds.all(source) as Array<{ job_id: string }>).map((r) => r.job_id),
      );
      const newJobs = isNewSource ? [] : jobs.filter((j) => !existing.has(j.id));

      const write = db.transaction((items: Job[]) => {
        for (const j of items) upsert.run({ source, jobId: j.id, now: nowIso });
      });
      write(jobs);

      return newJobs;
    },

    prune(graceDays: number): number {
      const cutoff = new Date(now() - graceDays * DAY_MS).toISOString();
      return deleteStale.run({ cutoff }).changes;
    },

    close(): void {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/state.ts test/state.test.ts
git commit -m "feat: add SQLite state store with seed-silently dedup"
```

---

### Task 3: `prune` behavior (prune & re-notify)

**Files:**
- Modify: `test/state.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `createSqliteStore` and its `now` option (from Task 2).
- Produces: verified `prune(graceDays)` semantics — ages out jobs not seen within the window; a pruned id reappearing counts as new.

`prune` itself is already implemented in Task 2's `state.ts`. This task adds the time-dependent tests that lock in its behavior using the injectable clock.

- [ ] **Step 1: Write the failing test**

Append to `test/state.test.ts`:

```ts
describe("prune", () => {
  it("removes jobs not seen within graceDays", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:acme", [job("1")]); // last_seen = Jan 1
    clock = Date.parse("2026-01-21T00:00:00Z");  // +20 days, job absent from board
    expect(store.prune(14)).toBe(1);
    store.close();
  });

  it("keeps jobs still within graceDays", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:acme", [job("1")]);
    clock = Date.parse("2026-01-10T00:00:00Z"); // +9 days
    expect(store.prune(14)).toBe(0);
    store.close();
  });

  it("re-notifies a job that reappears after being pruned", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:acme", [job("1")]); // seeded silently
    clock = Date.parse("2026-01-21T00:00:00Z");
    store.prune(14);                             // job 1 aged out
    const found = store.diffAndRecord("gh:acme", [job("1")]); // reappears
    expect(found.map((j) => j.id)).toEqual(["1"]); // source known -> counts as new
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/state.test.ts`
Expected: PASS (all `diffAndRecord` + `prune` tests). The `prune` logic already exists, so these pass immediately — they guard against regressions in the seed-silently/prune interaction.

- [ ] **Step 3: Commit**

```bash
git add test/state.test.ts
git commit -m "test: cover prune-and-re-notify semantics"
```

---

### Task 4: `poll()` orchestration function

**Files:**
- Create: `src/core/poll.ts`
- Test: `test/poll.test.ts` (create)

**Interfaces:**
- Consumes: `getAdapter`, `supportedAtses` from `src/adapters/index.js`; `sourceKeyOf` (Task 1); `StateStore` (Task 2); `HttpClient`, `Notification`, `Notifier`, `Target` from `src/core/types.js`.
- Produces:
  - `interface PollDeps { targets: Target[]; http: HttpClient; store: StateStore; notifier: Notifier; graceDays?: number; }`
  - `poll(deps: PollDeps): Promise<void>` — fetch each supported target, diff via the store, prune once, notify only new jobs.

- [ ] **Step 1: Write the failing test**

Create `test/poll.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { poll } from "../src/core/poll.js";
import { createSqliteStore } from "../src/core/state.js";
import type { HttpClient, Notification, Notifier, Target } from "../src/core/types.js";

// Returns a Greenhouse-shaped payload for any GET; postJson is never used here.
function fakeHttp(ids: number[]): HttpClient {
  return {
    async getJson<T>(): Promise<T> {
      return {
        jobs: ids.map((id) => ({
          id,
          title: `Job ${id}`,
          absolute_url: `https://x/${id}`,
          location: { name: "Remote" },
        })),
      } as T;
    },
    async postJson<T>(): Promise<T> {
      throw new Error("postJson not used in this test");
    },
  };
}

function capturingNotifier(sink: Notification[]): Notifier {
  return {
    async notifyBatch(items: Notification[]): Promise<void> {
      sink.push(...items);
    },
  };
}

const target: Target = { company: "Acme", ats: "greenhouse", token: "acme", tier: 1 };

describe("poll", () => {
  it("seeds silently on the first run, then notifies only new jobs", async () => {
    const store = createSqliteStore({ path: ":memory:" });

    const first: Notification[] = [];
    await poll({ targets: [target], http: fakeHttp([1]), store, notifier: capturingNotifier(first) });
    expect(first).toEqual([]); // seeded

    const second: Notification[] = [];
    await poll({ targets: [target], http: fakeHttp([1, 2]), store, notifier: capturingNotifier(second) });
    expect(second.map((n) => n.job.id)).toEqual(["2"]);
    expect(second[0]?.target.company).toBe("Acme");

    store.close();
  });

  it("skips targets whose ATS has no adapter", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const sink: Notification[] = [];
    const lever: Target = { company: "NoAdapter", ats: "lever", token: "x" };
    await poll({ targets: [lever], http: fakeHttp([1]), store, notifier: capturingNotifier(sink) });
    expect(sink).toEqual([]);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/poll.test.ts`
Expected: FAIL — cannot find module `../src/core/poll.js`.

- [ ] **Step 3: Write the implementation**

Create `src/core/poll.ts`:

```ts
import { getAdapter, supportedAtses } from "../adapters/index.js";
import { sourceKeyOf } from "../adapters/util.js";
import type { HttpClient, Notification, Notifier, Target } from "./types.js";
import type { StateStore } from "./state.js";

export interface PollDeps {
  targets: Target[];
  http: HttpClient;
  store: StateStore;
  notifier: Notifier;
  /** Prune window in days. Default 14. */
  graceDays?: number;
}

const DEFAULT_GRACE_DAYS = 14;

/**
 * One poll cycle: fetch each supported target, dedup against the store, prune
 * stale entries once, and notify only the jobs new to us. Per-target failures
 * are isolated — one bad fetch never aborts the run.
 */
export async function poll(deps: PollDeps): Promise<void> {
  const { targets, http, store, notifier } = deps;
  const graceDays = deps.graceDays ?? DEFAULT_GRACE_DAYS;
  const supported = new Set(supportedAtses());
  const found: Notification[] = [];

  for (const target of targets) {
    if (!supported.has(target.ats)) {
      console.log(`Skipping ${target.company}: adapter "${target.ats}" not implemented yet.`);
      continue;
    }
    try {
      const adapter = getAdapter(target.ats);
      const jobs = await adapter.fetchJobs(target, http);
      const newJobs = store.diffAndRecord(sourceKeyOf(target), jobs);
      console.log(`${target.company} (${target.ats}): ${jobs.length} job(s), ${newJobs.length} new`);
      for (const job of newJobs) found.push({ job, target });
    } catch (err) {
      console.error(`  ! ${target.company} failed: ${(err as Error).message}`);
    }
  }

  const removed = store.prune(graceDays);
  if (removed > 0) console.log(`Pruned ${removed} stale job(s).`);

  await notifier.notifyBatch(found);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/poll.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/poll.ts test/poll.test.ts
git commit -m "feat: add poll() orchestration with state-backed dedup"
```

---

### Task 5: Rewire `index.ts` to the store + `poll()`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `loadTargets` (config), `createHttpClient` (http), `createSqliteStore` (Task 2), `poll` (Task 4), `consoleNotifier` (notifiers).
- Produces: an entrypoint that opens the store, runs one `poll` cycle with real deps, and always closes the store.

- [ ] **Step 1: Replace `src/index.ts` contents**

Overwrite `src/index.ts` with:

```ts
import { loadTargets } from "./config.js";
import { createHttpClient } from "./core/http.js";
import { createSqliteStore } from "./core/state.js";
import { poll } from "./core/poll.js";
import { consoleNotifier } from "./notifiers/console.js";

// Phase 2 entrypoint: load targets, poll each supported source, dedup against
// persistent SQLite state, and print only newly-seen jobs. Telegram = later phase.
async function main(): Promise<void> {
  const store = createSqliteStore();
  try {
    await poll({
      targets: loadTargets(),
      http: createHttpClient(),
      store,
      notifier: consoleNotifier,
    });
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Typecheck the whole project**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites (`util`, `state`, `poll`).

- [ ] **Step 4: Manual end-to-end verification against the live boards**

Run: `npm start`
Expected (first run, empty `state.db`): each target prints `Company (greenhouse): N job(s), 0 new`, then `No new jobs.` — seed-silently confirmed.

Run: `npm start` again (unchanged boards)
Expected: same `N job(s), 0 new` lines and `No new jobs.` — dedup confirmed across runs.

- [ ] **Step 5: Confirm state is untracked**

Run: `git status --short`
Expected: clean — `state.db*` do not appear (already covered by `.gitignore`).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire entrypoint to SQLite state store and poll()"
```

---

## Self-Review

**Spec coverage:**
- Seed silently → Task 2 (`diffAndRecord` + `sources` table), tested in Tasks 2 & 4. ✓
- Local-dedup-only scope → no CI/state-branch tasks here. ✓
- Prune & re-notify (14-day default) → `prune` in Task 2, semantics tested in Task 3, wired with `DEFAULT_GRACE_DAYS` in Task 4. ✓
- Stable `source` key (not company) → Task 1, tested. ✓
- Data model (`seen_jobs` + `sources`) → Task 2. **Note:** spec is updated to add the `sources` table (the row-count check for new-source detection breaks after prune; `sources` fixes it). ✓
- `StateStore` interface (`diffAndRecord`/`prune`/`close`) → Task 2. ✓
- `poll()` extraction + injected deps → Task 4; `index.ts` trimmed → Task 5. ✓
- Tests: `state.test.ts` (seed/new/unchanged/prune/reappear) + `poll.test.ts` (fake http, capturing notifier) → Tasks 2–4. ✓
- Per-target error isolation + console format preserved → Task 4 keeps the try/catch and log lines. ✓

**Placeholder scan:** No TBD/TODO; every code and command step is concrete. ✓

**Type consistency:** `StateStore.diffAndRecord(source: string, jobs: Job[]): Job[]`, `prune(graceDays: number): number`, `close(): void`, `SqliteStoreOptions { path?, now? }`, `PollDeps { targets, http, store, notifier, graceDays? }`, and `sourceKeyOf(target): string` are used identically everywhere they appear. ✓
