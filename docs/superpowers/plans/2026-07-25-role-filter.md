# Phase 4 — Role Filter + Seed Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter company-board jobs to the user's preferred roles (notify/track only matching titles), and seed `sources.json` with verified Greenhouse AI/tech companies plus a `roles.json` filter.

**Architecture:** A pure `filterJobs`/`matchesRole` in a new `src/core/filter.ts`; `poll` applies it to company-source jobs before dedup; `index.ts` loads `roles.json`. The dedup/prune/notify/cron engine and query sources are reused untouched.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, vitest, tsx.

**Design source:** `docs/superpowers/specs/2026-07-25-role-filter-design.md` (approved).

## Global Constraints

- Node >= 20; ESM (`"type": "module"`) — relative imports use `.js` extensions; `import type` for type-only imports (`verbatimModuleSyntax` on).
- No new dependencies.
- Tests under `test/`, run with `npx vitest run`; `npm run typecheck` stays clean (strict, `noUncheckedIndexedAccess`).
- Filter applies to **company sources only**, **before** `diffAndRecord`. Query sources are unfiltered.
- Empty/absent filter (no `roleFilter`, or `include` empty) = **match all** — behavior identical to today.
- Matching: normalize (lowercase; collapse non-alphanumeric runs to single spaces; trim), then **word-boundary substring** (pad with spaces, match ` keyword `). Match iff ≥1 include term present AND 0 exclude terms present.
- Include: `software engineer, backend engineer, full stack engineer, fullstack engineer, ai engineer, agentic ai`. Exclude: `manager, director, vp, vice president, head of, intern, sales, lead, principal, senior`.
- `roles.json` and `sources.json` are committed config (NOT gitignored).

---

### Task 1: Pure role-filter core

**Files:**
- Create: `src/core/filter.ts`, `test/filter.test.ts`

**Interfaces:**
- Consumes: `Job` from `./types.js`.
- Produces:
  - `interface RoleFilter { include: string[]; exclude: string[] }`
  - `matchesRole(title: string, filter: RoleFilter): boolean` — word-boundary match; empty `include` ⇒ true.
  - `filterJobs(jobs: Job[], filter: RoleFilter): Job[]` — keeps matching jobs; empty `include` ⇒ returns all.

- [ ] **Step 1: Write `test/filter.test.ts` (RED)**

```ts
import { describe, it, expect } from "vitest";
import { matchesRole, filterJobs, type RoleFilter } from "../src/core/filter.js";
import type { Job } from "../src/core/types.js";

const FILTER: RoleFilter = {
  include: ["software engineer", "backend engineer", "full stack engineer", "fullstack engineer", "ai engineer", "agentic ai"],
  exclude: ["manager", "director", "vp", "vice president", "head of", "intern", "sales", "lead", "principal", "senior"],
};

function job(title: string): Job {
  return { id: title, title, url: "https://x", location: "Remote" };
}

describe("matchesRole", () => {
  it("matches a plain and a levelled include title", () => {
    expect(matchesRole("Software Engineer", FILTER)).toBe(true);
    expect(matchesRole("Backend Engineer II", FILTER)).toBe(true);
  });
  it("matches punctuation/spacing variants of full stack", () => {
    expect(matchesRole("Full-Stack Engineer", FILTER)).toBe(true);
    expect(matchesRole("Fullstack Engineer", FILTER)).toBe(true);
  });
  it("matches Agentic AI and AI Engineer", () => {
    expect(matchesRole("Agentic AI Engineer", FILTER)).toBe(true);
    expect(matchesRole("AI Engineer", FILTER)).toBe(true);
  });
  it("excludes management/senior/sales even when an include term is present", () => {
    expect(matchesRole("Software Engineering Manager", FILTER)).toBe(false); // "manager"
    expect(matchesRole("Senior Backend Engineer", FILTER)).toBe(false);      // "senior"
    expect(matchesRole("Principal Software Engineer", FILTER)).toBe(false);  // "principal"
    expect(matchesRole("Lead Software Engineer", FILTER)).toBe(false);       // "lead"
  });
  it("drops titles with no include term", () => {
    expect(matchesRole("Account Executive", FILTER)).toBe(false);
    expect(matchesRole("Product Designer", FILTER)).toBe(false);
  });
  it("does not false-match the short exclude 'vp' inside a word", () => {
    // "devpost" contains the substring "vp" but is not a whole-word 'vp'
    expect(matchesRole("Backend Engineer, Devpost", FILTER)).toBe(true);
  });
  it("empty include list matches everything", () => {
    expect(matchesRole("Anything At All", { include: [], exclude: ["manager"] })).toBe(true);
  });
});

describe("filterJobs", () => {
  it("keeps only matching jobs", () => {
    const jobs = [job("Backend Engineer"), job("Engineering Manager"), job("AI Engineer"), job("Recruiter")];
    expect(filterJobs(jobs, FILTER).map((j) => j.title)).toEqual(["Backend Engineer", "AI Engineer"]);
  });
  it("returns all jobs when include is empty", () => {
    const jobs = [job("Anything"), job("Sales Rep")];
    expect(filterJobs(jobs, { include: [], exclude: [] })).toEqual(jobs);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/filter.test.ts`
Expected: FAIL — cannot find `../src/core/filter.js`.

- [ ] **Step 3: Write `src/core/filter.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `npx vitest run test/filter.test.ts` → PASS (all).
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/filter.ts test/filter.test.ts
git commit -m "feat: add pure role-filter (word-boundary title matching)"
```

---

### Task 2: Wire the filter into config + poll + entrypoint

**Files:**
- Modify: `src/config.ts`, `src/core/poll.ts`, `src/index.ts`
- Create: `roles.json`, `roles.example.json`
- Modify: `test/poll.test.ts`

**Interfaces:**
- Consumes: `RoleFilter`, `filterJobs` (Task 1); `loadSources` (existing).
- Produces:
  - `loadRoleFilter(path?: string): RoleFilter` — missing file ⇒ `{include:[],exclude:[]}` (no filtering); present-but-unparseable ⇒ throws.
  - `PollDeps.roleFilter?: RoleFilter`; `poll` applies it to company-source jobs before `diffAndRecord`.

- [ ] **Step 1: Add `loadRoleFilter` to `src/config.ts`**

Add the import and function (keep `loadSources` as-is):
```ts
import type { RoleFilter } from "./core/filter.js";
```
```ts
/**
 * Load the role filter. A MISSING file means "no filtering" (returns empty
 * include/exclude); a present-but-malformed file throws. Full zod validation
 * is a later phase.
 */
export function loadRoleFilter(path = "roles.json"): RoleFilter {
  const abs = resolve(process.cwd(), path);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return { include: [], exclude: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse ${abs}: ${(err as Error).message}`);
  }
  const p = (parsed ?? {}) as Partial<RoleFilter>;
  return {
    include: Array.isArray(p.include) ? p.include.map(String) : [],
    exclude: Array.isArray(p.exclude) ? p.exclude.map(String) : [],
  };
}
```

- [ ] **Step 2: Apply the filter in `src/core/poll.ts`**

Add the import:
```ts
import { filterJobs } from "./filter.js";
import type { RoleFilter } from "./filter.js";
```
Add `roleFilter` to `PollDeps`:
```ts
export interface PollDeps {
  sources: Source[];
  http: HttpClient;
  store: StateStore;
  notifier: Notifier;
  /** Prune window in days. Default 14. */
  graceDays?: number;
  /** Optional global title filter, applied to company sources only. */
  roleFilter?: RoleFilter;
}
```
In `poll`, destructure `roleFilter` and apply it right after the fetch, for company sources only (replace the existing `const jobs = ...` line inside the try):
```ts
      let jobs = await fetchSource(source, http);
      if (source.kind === "company" && roleFilter) {
        jobs = filterJobs(jobs, roleFilter);
      }
```
(Everything else — `sourceKeyOf`, `diffAndRecord`, `okSources`, the summary log line, prune, notify — is unchanged. The summary line's `jobs.length` now reflects the post-filter count, which is the intended "matched" count.)

- [ ] **Step 3: Load and pass the filter in `src/index.ts`**

Add the import and pass it to `poll`:
```ts
import { loadSources, loadRoleFilter } from "./config.js";
```
```ts
    await poll({
      sources: loadSources(),
      http: createHttpClient(),
      store,
      notifier: consoleNotifier,
      roleFilter: loadRoleFilter(),
    });
```

- [ ] **Step 4: Create `roles.example.json` and `roles.json`**

`roles.example.json`:
```json
{
  "include": ["software engineer", "backend engineer", "full stack engineer", "fullstack engineer", "ai engineer", "agentic ai"],
  "exclude": ["manager", "director", "vp", "vice president", "head of", "intern", "sales", "lead", "principal", "senior"]
}
```
`roles.json` (same content — the user's active filter):
```json
{
  "include": ["software engineer", "backend engineer", "full stack engineer", "fullstack engineer", "ai engineer", "agentic ai"],
  "exclude": ["manager", "director", "vp", "vice president", "head of", "intern", "sales", "lead", "principal", "senior"]
}
```

- [ ] **Step 5: Add a poll filter test to `test/poll.test.ts` (RED first)**

Add inside `describe("poll", ...)`. Reuse the file's `capturingNotifier`, `createSqliteStore`, and Greenhouse-shaped fake pattern:
```ts
it("applies the role filter to company sources (only matching titles notify/record)", async () => {
  const store = createSqliteStore({ path: ":memory:" });
  const company: Source = { kind: "company", company: "Acme", ats: "greenhouse", token: "acme", tier: 1 };
  const roleFilter = { include: ["backend engineer"], exclude: ["senior"] };

  // Board returns a match, a senior (excluded), and an unrelated role.
  const jobsPayload = {
    jobs: [
      { id: 1, title: "Backend Engineer", absolute_url: "https://x/1", location: { name: "Remote" } },
      { id: 2, title: "Senior Backend Engineer", absolute_url: "https://x/2", location: { name: "Remote" } },
      { id: 3, title: "Sales Manager", absolute_url: "https://x/3", location: { name: "Remote" } },
    ],
  };
  const http: HttpClient = {
    async getJson<T>(): Promise<T> { return jobsPayload as T; },
    async postJson<T>(): Promise<T> { throw new Error("unused"); },
  };

  // Run 1 seeds silently. Run 2 (unchanged board) notifies nothing.
  const s1: Notification[] = [];
  await poll({ sources: [company], http, store, notifier: capturingNotifier(s1), roleFilter });
  expect(s1).toEqual([]);

  // Add a NEW matching job (id 4) plus a new non-matching one (id 5).
  const jobs2 = { jobs: [
    ...jobsPayload.jobs,
    { id: 4, title: "Full Stack Engineer", absolute_url: "https://x/4", location: { name: "Remote" } }, // not in include -> dropped
    { id: 5, title: "Backend Engineer, Platform", absolute_url: "https://x/5", location: { name: "Remote" } }, // matches
  ] };
  const http2: HttpClient = { async getJson<T>(): Promise<T> { return jobs2 as T; }, async postJson<T>(): Promise<T> { throw new Error("unused"); } };
  const s2: Notification[] = [];
  await poll({ sources: [company], http: http2, store, notifier: capturingNotifier(s2), roleFilter });
  expect(s2.map((n) => n.job.id)).toEqual(["5"]); // only the new *matching* job; id 4 filtered out, ids 1-3 already handled/filtered
  store.close();
});
```

- [ ] **Step 6: Run to verify the new test passes (machinery exists from Task 1)**

Run: `npx vitest run test/poll.test.ts` → PASS (new test + existing).
Note: existing poll tests call `poll(...)` WITHOUT `roleFilter`, proving back-compat (no filter ⇒ all jobs), so they must remain green unchanged.

- [ ] **Step 7: Full suite + typecheck + local sanity**

Run: `npx vitest run` → all green.
Run: `npm run typecheck` → clean.
Run: `npx tsx -e "import('./src/config.ts').then(m => { const f = m.loadRoleFilter(); console.log(f.include.length, f.exclude.length); })"` → prints `6 10`.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/core/poll.ts src/index.ts roles.json roles.example.json test/poll.test.ts
git commit -m "feat: apply role filter to company sources; load roles.json"
```

---

### Task 3: Seed sources.json with verified Greenhouse companies

**Files:**
- Modify: `sources.json`, `docs/deployment.md`

**Interfaces:**
- Consumes: the live Greenhouse Job Board API (public) to verify tokens.
- Produces: a `sources.json` of confirmed-working company sources + a doc note on the role filter and token verification.

- [ ] **Step 1: Verify candidate tokens against the live Greenhouse API**

Run this script (public API, no auth). It prints which candidate tokens resolve (HTTP 200) vs fail:
```bash
for t in anthropic databricks stripe airbnb scaleai cohere discord reddit coinbase robinhood doordash dropbox pinterest twitch brex plaid gusto samsara benchling ramp openai notion figma; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://boards-api.greenhouse.io/v1/boards/$t/jobs")
  echo "$code  $t"
done
```
Record which tokens returned `200`. Only those go into `sources.json`. (Tokens that 404/`301`/`403` are on a different ATS or use a different slug — drop them; a later adapter phase can add non-Greenhouse companies.)

- [ ] **Step 2: Write `sources.json` from the confirmed tokens**

Build the array from the Step-1 `200` results. Assign tiers by rough preference (AI-first companies tier 1, others tier 2). Shape per entry:
```json
{ "kind": "company", "company": "Anthropic", "ats": "greenhouse", "token": "anthropic", "tier": 1 }
```
Include ONLY confirmed-200 tokens. Keep the existing Stripe entry if it still resolves. Aim for the ~12–20 that verified. Example (final list depends on Step 1 — do not include unverified tokens):
```json
[
  { "kind": "company", "company": "Anthropic", "ats": "greenhouse", "token": "anthropic", "tier": 1 },
  { "kind": "company", "company": "Databricks", "ats": "greenhouse", "token": "databricks", "tier": 1 },
  { "kind": "company", "company": "Stripe", "ats": "greenhouse", "token": "stripe", "tier": 2 }
]
```

- [ ] **Step 3: Sanity-check the seeded config loads and is all company-kind**

Run: `npx tsx -e "import('./src/config.ts').then(m => { const s = m.loadSources(); console.log(s.length, s.every(x => x.kind === 'company')); })"`
Expected: prints the count and `true`.

- [ ] **Step 4: Note the role filter + verification in `docs/deployment.md`**

Append a short section:
```markdown
## Role filter (roles.json)

`roles.json` limits which company-board jobs you're notified about, by title:
- `include` — a job's title must contain one of these (word-boundary, case- and
  punctuation-insensitive), e.g. "backend engineer".
- `exclude` — …and none of these (e.g. "manager", "senior").

Empty or missing `roles.json` = no filtering (every job notifies). Query
(Adzuna) sources are not filtered — they're already scoped by their query.

`sources.json` company tokens are Greenhouse board slugs, verified against the
public board API at seed time. If a company later 404s in the run log
(`! <Company> failed: … 404 …`), its slug changed or it moved ATS — fix the
token or remove the entry.
```

- [ ] **Step 5: Commit**

```bash
git add sources.json docs/deployment.md
git commit -m "feat: seed sources.json with verified Greenhouse AI/tech companies"
```

---

## Self-Review

**Spec coverage:**
- Title filter on company sources, before dedup → Task 2 (`poll` applies `filterJobs` to `source.kind === "company"`). ✓
- Match semantics (normalize + word-boundary; include-any/exclude-none; empty ⇒ all) → Task 1 (`matchesRole`/`filterJobs`), tested. ✓ (word-boundary is a precise implementation of the spec's "substring", noted.)
- Include/exclude lists (with Lead/Principal/Senior excluded) → Task 2 `roles.json`. ✓
- Two config files, one purpose each → `sources.json` (Task 3) + `roles.json` (Task 2). ✓
- Empty/absent filter = match all → Task 1 (`filterJobs`) + Task 2 (`loadRoleFilter` missing-file ⇒ empty). ✓
- Curated Greenhouse companies, verified → Task 3 (live token check, only 200s seeded). ✓ (upgrades the spec's "best-effort" to "verified".)
- Query sources unaffected; engine/cron reused → Task 2 filters only company kind; no state/workflow change. ✓
- Tests: filter unit + poll integration → Tasks 1–2. ✓

**Placeholder scan:** No TBD/TODO. Task 3's final company list is intentionally determined by the live Step-1 check (not a placeholder — the verification IS the step); the example shows the exact shape.

**Type consistency:** `RoleFilter { include: string[]; exclude: string[] }`, `matchesRole(title, filter)`, `filterJobs(jobs, filter)`, `loadRoleFilter(): RoleFilter`, and `PollDeps.roleFilter?: RoleFilter` are used identically across Tasks 1–2 and their tests.
