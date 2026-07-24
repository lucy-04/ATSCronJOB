# Phase 3 — Scheduled Cron + Persistent State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the poller hourly in GitHub Actions, persisting `state.db` between stateless runs via an orphan `state` branch, and fix prune so it never ages out a source whose fetch failed this run.

**Architecture:** A workflow checks out `main` (code) and the `state` branch (prior `state.db`) side by side, runs the poller pointed at the checked-out DB via `STATE_DB_PATH`, then amends a single state commit and force-pushes it back. Code changes: env-configurable DB path, a WAL checkpoint on close so the committed file is always complete, and prune scoped to successfully-fetched sources.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, vitest, tsx; GitHub Actions (`actions/checkout@v4`, `actions/setup-node@v4`).

## Global Constraints

- Node >= 20; ESM (`"type": "module"`) — relative imports use `.js` extensions; `import type` for type-only imports (`verbatimModuleSyntax` on).
- No new dependencies.
- Tests live under `test/`, run with `npx vitest run <file>`; `npm run typecheck` must stay clean (strict, `noUncheckedIndexedAccess`).
- The store's DB path is controlled by the `STATE_DB_PATH` env var, defaulting to `state.db` when unset.
- `prune` only removes rows for sources whose fetch succeeded this run (passed explicitly).
- `state.db*` is never committed to `main` (already in `.gitignore`); it lives only on the orphan `state` branch.
- Workflow: hourly `cron: '0 * * * *'` + `workflow_dispatch`; `permissions: contents: write`; a `concurrency` group; the `state` branch is kept a single commit via `git commit --amend` + `git push --force-with-lease`.
- Injectable clock (`now?: () => number`) is used for all time-dependent tests — never real wall-clock waits.

---

### Task 1: Scope `prune` to successfully-fetched sources

**Files:**
- Modify: `src/core/state.ts`
- Modify: `src/core/poll.ts`
- Modify: `test/state.test.ts`
- Modify: `test/poll.test.ts`

**Interfaces:**
- Consumes: existing `StateStore`, `createSqliteStore`, `sourceKeyOf`, the greenhouse adapter, and `poll`'s existing structure.
- Produces:
  - `StateStore.prune(graceDays: number, sources: string[]): number` — deletes stale rows ONLY for the given sources; returns rows removed; returns 0 when `sources` is empty.
  - `poll()` collects the source key of every target whose fetch+dedup succeeded and passes that list to `prune`.

- [ ] **Step 1: Update the state prune tests to the new signature + add scoping tests (RED)**

In `test/state.test.ts`, find the existing `describe("prune", ...)` block. Change every existing `store.prune(14)` call to `store.prune(14, ["gh:acme"])` (the source used in those tests). Then append these tests inside the same `describe("prune", ...)` block:

```ts
  it("prunes nothing when the sources list is empty", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:acme", [job("1")]);
    clock = Date.parse("2026-01-21T00:00:00Z"); // +20d, would be stale
    expect(store.prune(14, [])).toBe(0);
    // proof it was prunable: pruning WITH the source now removes it
    expect(store.prune(14, ["gh:acme"])).toBe(1);
    store.close();
  });

  it("only prunes the sources it is given", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:a", [job("1")]);
    store.diffAndRecord("gh:b", [job("1")]);
    clock = Date.parse("2026-01-21T00:00:00Z"); // +20d, both stale
    expect(store.prune(14, ["gh:a"])).toBe(1); // only gh:a
    expect(store.prune(14, ["gh:b"])).toBe(1); // gh:b still there until named
    store.close();
  });
```

- [ ] **Step 2: Run the state tests to verify they fail**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL — `prune` currently takes 1 argument; TypeScript/assertion errors on the new 2-arg calls.

- [ ] **Step 3: Implement the new `prune` in `state.ts`**

In `src/core/state.ts`, replace the `deleteStale` prepared statement and the `prune` method.

Replace the statement:
```ts
  const deleteStale = db.prepare(`DELETE FROM seen_jobs WHERE last_seen < @cutoff`);
```
with:
```ts
  const deleteStaleForSource = db.prepare(
    `DELETE FROM seen_jobs WHERE source = @source AND last_seen < @cutoff`,
  );
```

Replace the `prune` method:
```ts
    prune(graceDays: number): number {
      const cutoff = new Date(now() - graceDays * DAY_MS).toISOString();
      return deleteStale.run({ cutoff }).changes;
    },
```
with:
```ts
    // Only prunes the given sources — a source whose fetch failed this run is
    // omitted by the caller, so its jobs are never mistaken for "gone."
    prune(graceDays: number, sources: string[]): number {
      if (sources.length === 0) return 0;
      const cutoff = new Date(now() - graceDays * DAY_MS).toISOString();
      const run = db.transaction((srcs: string[]): number => {
        let removed = 0;
        for (const source of srcs) {
          removed += deleteStaleForSource.run({ source, cutoff }).changes;
        }
        return removed;
      });
      return run(sources);
    },
```

Also update the `StateStore` interface's `prune` signature:
```ts
  /** Remove jobs (only for the given sources) whose last_seen is older than graceDays; return rows removed. */
  prune(graceDays: number, sources: string[]): number;
```

- [ ] **Step 4: Run the state tests to verify they pass**

Run: `npx vitest run test/state.test.ts`
Expected: PASS (all prune tests, including the two new ones).

- [ ] **Step 5: Add the poll failure-isolation test (RED)**

In `test/poll.test.ts`, add a per-token configurable fake HTTP client and a new test. Add this helper near the top (after the existing imports/helpers):

```ts
// Fake HTTP whose behavior depends on the Greenhouse board token in the URL:
// an array of ids returns that job list; "fail" throws.
function httpFor(behavior: Record<string, number[] | "fail">): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T> {
      const token = url.match(/\/boards\/([^/]+)\/jobs/)?.[1] ?? "";
      const b = behavior[token];
      if (b === undefined || b === "fail") throw new Error(`boom for ${token}`);
      return {
        jobs: b.map((id) => ({
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
```

Then add this test inside the `describe("poll", ...)` block:

```ts
  it("does not prune a source whose fetch failed this run", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    const a: Target = { company: "A", ats: "greenhouse", token: "a", tier: 1 };
    const b: Target = { company: "B", ats: "greenhouse", token: "b", tier: 1 };

    // Run 1 (T0): both boards healthy -> both seed silently.
    await poll({ targets: [a, b], http: httpFor({ a: [1], b: [1] }), store, notifier: { async notifyBatch() {} } });

    // Run 2 (T0+20d): board A is DOWN, B healthy. A's job (last_seen T0) is now
    // old enough to be prunable, but because A's fetch failed it must NOT be pruned.
    clock = Date.parse("2026-01-21T00:00:00Z");
    await poll({ targets: [a, b], http: httpFor({ a: "fail", b: [1] }), store, notifier: { async notifyBatch() {} } });

    // Run 3 (same clock): A recovers with the SAME job id. If A's row had been
    // pruned during its outage, job "1" would resurface as NEW here. It must not.
    const sink: Notification[] = [];
    await poll({ targets: [a, b], http: httpFor({ a: [1], b: [1] }), store, notifier: capturingNotifier(sink) });
    expect(sink).toEqual([]); // A's job survived the outage -> nothing new

    store.close();
  });
```

- [ ] **Step 6: Run poll tests to verify the new test fails**

Run: `npx vitest run test/poll.test.ts`
Expected: FAIL — `poll` still calls `store.prune(graceDays)` (1 arg), so it won't compile against the new signature; if it did compile, the global prune would have removed A's job and Run 3 would notify it.

- [ ] **Step 7: Update `poll()` to collect and pass ok-sources**

In `src/core/poll.ts`, inside `poll()`:

Add an accumulator next to `found`:
```ts
  const found: Notification[] = [];
  const okSources: string[] = [];
```

In the `try` block, capture the key and record success (replace the existing fetch/dedup lines):
```ts
      const adapter = getAdapter(target.ats);
      const jobs = await adapter.fetchJobs(target, http);
      const source = sourceKeyOf(target);
      const newJobs = store.diffAndRecord(source, jobs);
      okSources.push(source);
      console.log(`${target.company} (${target.ats}): ${jobs.length} job(s), ${newJobs.length} new`);
      for (const job of newJobs) found.push({ job, target });
```

Change the prune call after the loop:
```ts
  const removed = store.prune(graceDays, okSources);
```

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npx vitest run`
Expected: PASS — all suites (util, state, poll) green.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/core/state.ts src/core/poll.ts test/state.test.ts test/poll.test.ts
git commit -m "feat: scope prune to successfully-fetched sources"
```

---

### Task 2: Checkpoint WAL into the main DB file on close

**Files:**
- Modify: `src/core/state.ts`
- Modify: `test/state.test.ts`

**Interfaces:**
- Consumes: `createSqliteStore` (Task 1 state).
- Produces: `close()` now runs `PRAGMA wal_checkpoint(TRUNCATE)` before closing, so a committed `state.db` never has outstanding writes stranded in a `-wal` side file.

- [ ] **Step 1: Write the failing test (RED)**

In `test/state.test.ts`, ensure these imports exist at the top (add any that are missing — some may already be present from the Phase 2 `first_seen` test):
```ts
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```
Then add a new describe block:
```ts
describe("close (WAL checkpoint)", () => {
  it("folds WAL writes into the main db file and truncates the -wal file", () => {
    const dir = mkdtempSync(join(tmpdir(), "state-wal-"));
    const dbPath = join(dir, "state.db");
    try {
      const store = createSqliteStore({ path: dbPath });
      store.diffAndRecord("gh:acme", [job("1")]);
      store.close();

      // After a TRUNCATE checkpoint the -wal file is either gone or 0 bytes.
      const wal = `${dbPath}-wal`;
      const walSize = existsSync(wal) ? statSync(wal).size : 0;
      expect(walSize).toBe(0);

      // And the row is readable from the main file alone.
      const reopened = new Database(dbPath, { readonly: true });
      const row = reopened
        .prepare("SELECT job_id FROM seen_jobs WHERE source = ?")
        .get("gh:acme") as { job_id: string } | undefined;
      reopened.close();
      expect(row?.job_id).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/state.test.ts -t "WAL checkpoint"`
Expected: FAIL — without an explicit checkpoint the `-wal` file may be non-empty at close (assertion `walSize === 0` fails). (If it happens to pass by autocheckpoint timing, still add the pragma in Step 3 to make it guaranteed, then re-run.)

- [ ] **Step 3: Add the checkpoint to `close()`**

In `src/core/state.ts`, change the `close` method:
```ts
    close(): void {
      db.close();
    },
```
to:
```ts
    close(): void {
      // Fold any WAL writes into state.db and truncate the -wal file, so a
      // committed state.db (Phase 3 persistence) is always complete on its own.
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/state.test.ts -t "WAL checkpoint"`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx vitest run` → PASS (all suites).
Run: `npm run typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/state.ts test/state.test.ts
git commit -m "feat: checkpoint WAL into state.db on close"
```

---

### Task 3: Env-configurable DB path in the entrypoint

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `createSqliteStore({ path })` (existing option).
- Produces: `index.ts` opens the store at `process.env.STATE_DB_PATH` when set, else the default `state.db`.

- [ ] **Step 1: Update `src/index.ts`**

Change the store construction line:
```ts
  const store = createSqliteStore();
```
to:
```ts
  // STATE_DB_PATH lets CI point at the checked-out state branch copy; unset
  // locally falls through to the store's default of "state.db".
  const store = createSqliteStore({ path: process.env.STATE_DB_PATH || undefined });
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Verify the env var is honored (custom path)**

better-sqlite3 creates the DB file as soon as the store is constructed (before any network call), so this check is deterministic regardless of network access.

Run:
```bash
TMP=$(mktemp -d)
STATE_DB_PATH="$TMP/custom.db" npm start >/dev/null 2>&1 || true
test -f "$TMP/custom.db" && echo "CUSTOM PATH OK" || echo "CUSTOM PATH MISSING"
rm -rf "$TMP"
```
Expected: `CUSTOM PATH OK`.

- [ ] **Step 4: Verify the default path still works**

Run:
```bash
rm -f state.db state.db-wal state.db-shm
npm start >/dev/null 2>&1 || true
test -f state.db && echo "DEFAULT PATH OK" || echo "DEFAULT PATH MISSING"
```
Expected: `DEFAULT PATH OK`.

- [ ] **Step 5: Confirm no DB artifacts are staged**

Run: `git status --short`
Expected: `state.db*` do NOT appear (gitignored). Only `src/index.ts` is modified.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: honor STATE_DB_PATH for the state db location"
```

---

### Task 4: GitHub Actions workflow + deployment doc

**Files:**
- Create: `.github/workflows/poll.yml`
- Create: `docs/deployment.md`

**Interfaces:**
- Consumes: `npm start` honoring `STATE_DB_PATH` (Task 3); the orphan `state` branch (created by the one-time bootstrap in the deployment doc).
- Produces: an hourly workflow that persists `state.db` to the `state` branch as a single amended commit.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/poll.yml`:

```yaml
name: Poll ATS boards

on:
  schedule:
    - cron: '0 * * * *'   # hourly, at the top of the hour (UTC)
  workflow_dispatch: {}

permissions:
  contents: write

concurrency:
  group: poll
  cancel-in-progress: false

jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code (main)
        uses: actions/checkout@v4

      - name: Checkout state branch
        uses: actions/checkout@v4
        with:
          ref: state
          path: state-data
          persist-credentials: true

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run poller
        env:
          STATE_DB_PATH: state-data/state.db
        run: npm start

      - name: Persist state
        working-directory: state-data
        run: |
          if [ -z "$(git status --porcelain -- state.db)" ]; then
            echo "No state change; nothing to persist."
            exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add state.db
          git commit --amend --no-edit
          git push --force-with-lease origin state
```

- [ ] **Step 2: Validate the YAML parses**

Run: `ruby -ryaml -e "YAML.load_file('.github/workflows/poll.yml'); puts 'YAML OK'"`
Expected: `YAML OK`. (macOS ships Ruby with the Psych YAML library. If Ruby is unavailable, use `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/poll.yml')); print('YAML OK')"` — and if PyYAML is missing, report that and rely on the post-merge dispatch for validation.)

- [ ] **Step 3: Dry-run the persist logic locally (proves the flat single-commit mechanic)**

This reproduces the `state-data` git flow in a throwaway repo to confirm the amend + force-push keeps exactly one commit. Run:
```bash
set -e
T=$(mktemp -d); R="$T/remote.git"; W="$T/work"
git init --bare "$R" >/dev/null
# bootstrap: orphan state branch with an empty init commit
git init "$W" >/dev/null
git -C "$W" remote add origin "$R"
git -C "$W" checkout --orphan state >/dev/null 2>&1
git -C "$W" -c user.name=x -c user.email=x@x commit --allow-empty -m "Initialize state branch" >/dev/null
git -C "$W" push -u origin state >/dev/null 2>&1
# run 1: create state.db, amend, force-push
echo "db-v1" > "$W/state.db"
git -C "$W" add state.db
git -C "$W" -c user.name=x -c user.email=x@x commit --amend --no-edit >/dev/null
git -C "$W" push --force-with-lease origin state >/dev/null 2>&1
# run 2: change state.db, amend, force-push
echo "db-v2" > "$W/state.db"
git -C "$W" add state.db
git -C "$W" -c user.name=x -c user.email=x@x commit --amend --no-edit >/dev/null
git -C "$W" push --force-with-lease origin state >/dev/null 2>&1
COUNT=$(git -C "$W" rev-list --count state)
CONTENT=$(git -C "$W" show state:state.db)
echo "commits=$COUNT content=$CONTENT"
rm -rf "$T"
```
Expected: `commits=1 content=db-v2` — a single commit holding the latest content, proving history stays flat.

- [ ] **Step 4: Write the deployment doc**

Create `docs/deployment.md`:

```markdown
# Deployment (Phase 3)

The poller runs hourly via GitHub Actions (`.github/workflows/poll.yml`) and keeps
its dedup state (`state.db`) on an orphan `state` branch — never on `main`.

## One-time setup

1. **Allow the workflow to push.** GitHub → repo Settings → Actions → General →
   Workflow permissions → select **Read and write permissions** → Save.

2. **Bootstrap the orphan `state` branch** (holds only `state.db`, no shared
   history with `main`):

   ```bash
   git checkout --orphan state
   git rm -rf .
   printf 'state.db-wal\nstate.db-shm\n' > .gitignore   # never track WAL side files
   git add .gitignore
   git commit -m "Initialize state branch"
   git push -u origin state
   git checkout main
   ```

3. **Trigger the first run manually** to confirm it works: GitHub → Actions →
   "Poll ATS boards" → **Run workflow**. The first run seeds every source silently
   (0 new) and writes the first `state.db` to the `state` branch.

## How it works

Each run: checks out `main` (code) and the `state` branch (prior `state.db`) side
by side, runs `STATE_DB_PATH=state-data/state.db npm start`, then amends the single
state commit and force-pushes it. New roles are logged to the Actions run log
(a Telegram notifier is Phase 4). Runs never overlap (a `concurrency` group), and
the `state` branch stays one commit forever (`commit --amend` + `--force-with-lease`).

## Schedule

Hourly (`cron: '0 * * * *'`, UTC). GitHub may delay scheduled runs under load, and
disables scheduled workflows after 60 days of repo inactivity — push or run
manually to re-enable. Adjust cadence by editing the `cron` line.
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/poll.yml docs/deployment.md
git commit -m "feat: add hourly poll workflow with state-branch persistence"
```

---

## Self-Review

**Spec coverage:**
- Hourly cron + `workflow_dispatch` → Task 4 (`schedule` + `workflow_dispatch`). ✓
- Two-checkout persistence (code + state branch) → Task 4 workflow. ✓
- `STATE_DB_PATH` env, default `state.db` → Task 3 (+ tests for both paths). ✓
- WAL checkpoint on close → Task 2 (+ on-disk test asserting `-wal` truncated and data readable). ✓
- Prune scoped to successfully-fetched sources → Task 1 (`prune(graceDays, sources)`, `okSources` in poll, state + poll tests). ✓
- Flat `state` branch via amend + `--force-with-lease` → Task 4 workflow + local dry-run proving `commits=1`. ✓
- `concurrency` group + `contents: write` → Task 4 workflow. ✓
- Bootstrap + enabling write perms + WAL side-file ignore → Task 4 `docs/deployment.md`. ✓
- `state.db` never on `main` → unchanged `.gitignore`; Task 3 Step 5 asserts nothing staged. ✓
- Telegram explicitly out of scope → no task builds it. ✓

**Placeholder scan:** No TBD/TODO; every code, YAML, and command step is concrete.

**Type consistency:** `prune(graceDays: number, sources: string[]): number` is defined in the `StateStore` interface (Task 1 Step 3), implemented identically in `createSqliteStore` (Task 1 Step 3), and called as `store.prune(graceDays, okSources)` in `poll()` (Task 1 Step 7) and as `store.prune(14, [...])` in tests (Task 1 Steps 1). `createSqliteStore({ path })` / `{ now }` / `{ path: process.env.STATE_DB_PATH || undefined }` all match the existing `SqliteStoreOptions`. `STATE_DB_PATH` is the same env name in `index.ts` (Task 3) and the workflow (Task 4).
