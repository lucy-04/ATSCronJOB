# Hybrid Search — Title/Keyword Sources (Adzuna) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the poller search by title/keyword across all companies (via Adzuna) in addition to polling specific company ATS boards, feeding both into the existing dedup/prune/notify/state engine.

**Architecture:** Generalize the company-only `Target` into a discriminated `Source` union (`CompanySource | QuerySource`). Company sources keep hitting ATS boards; query sources hit Adzuna's keyword search. `poll` dispatches on `source.kind`. The dedup `StateStore`, prune, `Notifier`, and the state-branch workflow are reused unchanged — only the fetch layer and the config/notification shape generalize.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, vitest, tsx; Adzuna REST API; GitHub Actions.

**Design source:** `/Users/lakshaytuteja/.claude/plans/before-phase-1-i-whimsical-alpaca.md` (approved).

## Global Constraints

- Node >= 20; ESM (`"type": "module"`) — relative imports use `.js` extensions; `import type` for type-only imports (`verbatimModuleSyntax` on).
- No new dependencies.
- Tests under `test/`, run with `npx vitest run`; `npm run typecheck` stays clean (strict, `noUncheckedIndexedAccess`).
- Injectable `HttpClient` in tests (recorded fixtures, no live network); injectable clock for time tests.
- Dedup identity is `Job.id`; a source's stable key comes from `sourceKeyOf(source)`, never the display label.
- Adzuna auth via `app_id`/`app_key` query params read from `process.env.ADZUNA_APP_ID` / `ADZUNA_APP_KEY`; missing keys throw (caught per-source in `poll`, so query sources degrade gracefully).
- Company sources preserve current behavior and console output exactly.

---

### Task 1: Generalize `Target` → `Source` (company-only, build stays green)

**Files:**
- Modify: `src/core/types.ts`, `src/adapters/util.ts`, `src/adapters/index.ts`, `src/adapters/greenhouse.ts`, `src/core/poll.ts`, `src/notifiers/console.ts`, `src/config.ts`
- Modify (tests): `test/util.test.ts`, `test/poll.test.ts`

**Interfaces:**
- Produces:
  - `type Source = CompanySource | QuerySource` (discriminated on `kind`); `CompanySource` has `kind:"company"` + today's fields; `QuerySource` has `kind:"query"` + `provider,query,where,country,label`.
  - `Job.company?: string`.
  - `interface CompanyAdapter { ats; fetchJobs(source: CompanySource, http): Promise<Job[]> }`, `interface QueryAdapter { provider; fetchJobs(source: QuerySource, http): Promise<Job[]> }`.
  - `Notification { job; source: Source }`.
  - `sourceKeyOf(source: Source): string`, `sourceLabel(source: Source): string`, `tokenOf(source: CompanySource): string`.
  - `getCompanyAdapter(ats)`, `supportedAtses()`, `getQueryAdapter(provider)`, `supportedProviders()`.
- Consumes: existing `StateStore`, `HttpClient`.

- [ ] **Step 1: Update `test/util.test.ts` for the `Source` shape (RED)**

Replace the contents of `test/util.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sourceKeyOf, sourceLabel } from "../src/adapters/util.js";
import type { Source } from "../src/core/types.js";

describe("sourceKeyOf", () => {
  it("keys a token-based company by ats and token", () => {
    const s: Source = { kind: "company", company: "Acme", ats: "greenhouse", token: "acme" };
    expect(sourceKeyOf(s)).toBe("greenhouse:acme");
  });

  it("keys a workday company by ats, tenant, and site", () => {
    const s: Source = { kind: "company", company: "Big Co", ats: "workday", tenant: "bigco", dc: "wd1", site: "External" };
    expect(sourceKeyOf(s)).toBe("workday:bigco:External");
  });

  it("keys a query source by provider, query, where, and country (slugged, stable across label renames)", () => {
    const a: Source = { kind: "query", provider: "adzuna", query: "ML Engineer", where: "Remote", country: "us", label: "nickname A" };
    const b: Source = { kind: "query", provider: "adzuna", query: "ML Engineer", where: "Remote", country: "us", label: "nickname B" };
    expect(sourceKeyOf(a)).toBe("adzuna:ml-engineer|remote|us");
    expect(sourceKeyOf(a)).toBe(sourceKeyOf(b));
  });
});

describe("sourceLabel", () => {
  it("uses the company name for company sources", () => {
    const s: Source = { kind: "company", company: "Acme", ats: "greenhouse", token: "acme" };
    expect(sourceLabel(s)).toBe("Acme");
  });
  it("uses the label for query sources", () => {
    const s: Source = { kind: "query", provider: "adzuna", query: "ML", where: "Remote", country: "us", label: "ML remote" };
    expect(sourceLabel(s)).toBe("ML remote");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/util.test.ts`
Expected: FAIL — `sourceLabel` not exported; `Source` shape mismatch.

- [ ] **Step 3: Rewrite `src/core/types.ts`**

Replace the whole file:

```ts
// Core contracts shared across adapters, notifiers, and the poller.
// Everything downstream depends on these types; keep them small and stable.

export type Ats =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workable"
  | "workday";

export type Provider = "adzuna";

/**
 * A single job posting, normalized across every source.
 * `id` is the identity used for dedup — NOT a timestamp — so a missing
 * `postedAt` never blocks new-job detection.
 */
export interface Job {
  id: string;
  title: string;
  url: string;
  location: string;
  /** Hiring company. Set by aggregator (query) sources, where it varies per job. */
  company?: string;
  department?: string;
  /** ISO-8601 when the source provides it. Display/sort only. */
  postedAt?: string;
}

interface CompanyCommon {
  kind: "company";
  /** Human display name, shown in notifications. */
  company: string;
  /** Label-only. Shown in notifications and used for sort order. Default 3. */
  tier?: number;
}

/** ATS boards whose endpoint needs a single slug/id in `token`. */
export interface SimpleSource extends CompanyCommon {
  ats: "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable";
  token: string;
}

/** Workday needs tenant + data-center shard + site, discovered via DevTools. */
export interface WorkdaySource extends CompanyCommon {
  ats: "workday";
  tenant: string;
  /** The {wdN} shard, e.g. "wd1" | "wd3" | "wd5". */
  dc: string;
  /** The careers site path, e.g. "External". */
  site: string;
}

/** A specific company's ATS board. Discriminated on `ats`. */
export type CompanySource = SimpleSource | WorkdaySource;

/** A saved title/keyword search against an aggregator (cross-company). */
export interface QuerySource {
  kind: "query";
  provider: Provider;
  /** Title/keywords to search for. */
  query: string;
  /** Location filter, e.g. "Remote" or "New York". */
  where: string;
  /** ISO country code segment for the aggregator, e.g. "us" | "gb". */
  country: string;
  /** Human nickname, shown in notifications and used for sort order. */
  label: string;
  tier?: number;
}

/** Anything the poller can fetch from. Discriminated on `kind`. */
export type Source = CompanySource | QuerySource;

/**
 * Minimal HTTP surface adapters depend on. Injected so tests can supply a fake
 * that returns a recorded fixture — no global-fetch mocking, no live network.
 */
export interface HttpClient {
  getJson<T = unknown>(url: string, init?: RequestInit): Promise<T>;
  postJson<T = unknown>(url: string, body: unknown, init?: RequestInit): Promise<T>;
}

/** Fetches a specific company's board. */
export interface CompanyAdapter {
  readonly ats: Ats;
  fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]>;
}

/** Fetches an aggregator title/keyword search. */
export interface QueryAdapter {
  readonly provider: Provider;
  fetchJobs(source: QuerySource, http: HttpClient): Promise<Job[]>;
}

/** A job paired with the source it came from, for notification rendering. */
export interface Notification {
  job: Job;
  source: Source;
}

/**
 * Batched so a burst of new roles is throttled as one operation rather than
 * one unthrottled message per job.
 */
export interface Notifier {
  notifyBatch(items: Notification[]): Promise<void>;
}
```

- [ ] **Step 4: Rewrite `src/adapters/util.ts`**

Replace the whole file:

```ts
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
  return `${source.ats}:${source.token}`;
}

/** Display name shown in notifications. */
export function sourceLabel(source: Source): string {
  return source.kind === "query" ? source.label : source.company;
}
```

- [ ] **Step 5: Rewrite `src/adapters/index.ts`**

Replace the whole file:

```ts
import type { Ats, CompanyAdapter, Provider, QueryAdapter } from "../core/types.js";
import { greenhouseAdapter } from "./greenhouse.js";

// Company ATS adapters, keyed by ATS. Others (lever, ashby, …) register here.
const companyRegistry: Partial<Record<Ats, CompanyAdapter>> = {
  greenhouse: greenhouseAdapter,
};

// Aggregator query adapters, keyed by provider. Adzuna registers in Task 2.
const queryRegistry: Partial<Record<Provider, QueryAdapter>> = {};

export function getCompanyAdapter(ats: Ats): CompanyAdapter {
  const adapter = companyRegistry[ats];
  if (!adapter) throw new Error(`No adapter registered for ATS "${ats}"`);
  return adapter;
}

export function supportedAtses(): Ats[] {
  return Object.keys(companyRegistry) as Ats[];
}

export function getQueryAdapter(provider: Provider): QueryAdapter {
  const adapter = queryRegistry[provider];
  if (!adapter) throw new Error(`No adapter registered for provider "${provider}"`);
  return adapter;
}

export function supportedProviders(): Provider[] {
  return Object.keys(queryRegistry) as Provider[];
}

export { queryRegistry };
```

(Exporting `queryRegistry` lets Task 2 register adzuna by import side-effect or direct assignment; Task 2 will instead add adzuna to the literal above — see Task 2.)

- [ ] **Step 6: Update `src/adapters/greenhouse.ts` signature**

Change the import and the `fetchJobs` signature only (body unchanged):

```ts
import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";
```
```ts
export const greenhouseAdapter: CompanyAdapter = {
  ats: "greenhouse",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
      tokenOf(source),
    )}/jobs?content=true`;
    const data = await http.getJson<GreenhouseResponse>(url);
    return (data.jobs ?? []).map(normalize);
  },
};
```
(Keep the existing `GreenhouseJob`/`GreenhouseResponse` interfaces and `normalize`. Update the `tokenOf` call arg name from `target` to `source`.)

- [ ] **Step 7: Rewrite `src/core/poll.ts`**

Replace the whole file:

```ts
import {
  getCompanyAdapter,
  getQueryAdapter,
  supportedAtses,
  supportedProviders,
} from "../adapters/index.js";
import { sourceKeyOf, sourceLabel } from "../adapters/util.js";
import type { HttpClient, Job, Notification, Notifier, Source } from "./types.js";
import type { StateStore } from "./state.js";

export interface PollDeps {
  sources: Source[];
  http: HttpClient;
  store: StateStore;
  notifier: Notifier;
  /** Prune window in days. Default 14. */
  graceDays?: number;
}

const DEFAULT_GRACE_DAYS = 14;

/** Fetch one source's jobs, or throw. Dispatches on kind so each adapter stays typed. */
async function fetchSource(source: Source, http: HttpClient): Promise<Job[]> {
  if (source.kind === "query") {
    return getQueryAdapter(source.provider).fetchJobs(source, http);
  }
  return getCompanyAdapter(source.ats).fetchJobs(source, http);
}

/** True if we have an adapter for this source's kind. */
function isSupported(source: Source, atses: Set<string>, providers: Set<string>): boolean {
  return source.kind === "query" ? providers.has(source.provider) : atses.has(source.ats);
}

/**
 * One poll cycle: fetch each supported source, dedup against the store, prune
 * (only sources that fetched OK), and notify only the jobs new to us. Per-source
 * failures are isolated — one bad fetch never aborts the run.
 */
export async function poll(deps: PollDeps): Promise<void> {
  const { sources, http, store, notifier } = deps;
  const graceDays = deps.graceDays ?? DEFAULT_GRACE_DAYS;
  const atses = new Set<string>(supportedAtses());
  const providers = new Set<string>(supportedProviders());
  const found: Notification[] = [];
  const okSources: string[] = [];

  for (const source of sources) {
    const label = sourceLabel(source);
    if (!isSupported(source, atses, providers)) {
      const which = source.kind === "query" ? `provider "${source.provider}"` : `adapter "${source.ats}"`;
      console.log(`Skipping ${label}: ${which} not implemented yet.`);
      continue;
    }
    try {
      const jobs = await fetchSource(source, http);
      const key = sourceKeyOf(source);
      const newJobs = store.diffAndRecord(key, jobs);
      okSources.push(key);
      console.log(`${label}: ${jobs.length} job(s), ${newJobs.length} new`);
      for (const job of newJobs) found.push({ job, source });
    } catch (err) {
      console.error(`  ! ${label} failed: ${(err as Error).message}`);
    }
  }

  const removed = store.prune(graceDays, okSources);
  if (removed > 0) console.log(`Pruned ${removed} stale job(s).`);

  await notifier.notifyBatch(found);
}
```

- [ ] **Step 8: Rewrite `src/notifiers/console.ts`**

Replace the whole file:

```ts
import { sourceLabel } from "../adapters/util.js";
import type { Notification, Notifier } from "../core/types.js";

// Sorts by tier (lower = higher priority) then label, so the most important
// roles print first. Used for local runs and as a fallback notifier.
function byTierThenLabel(a: Notification, b: Notification): number {
  const ta = a.source.tier ?? 3;
  const tb = b.source.tier ?? 3;
  if (ta !== tb) return ta - tb;
  return sourceLabel(a.source).localeCompare(sourceLabel(b.source));
}

export const consoleNotifier: Notifier = {
  async notifyBatch(items: Notification[]): Promise<void> {
    if (items.length === 0) {
      console.log("No new jobs.");
      return;
    }
    console.log(`\n${items.length} new job(s):\n`);
    for (const { job, source } of [...items].sort(byTierThenLabel)) {
      const tier = source.tier ?? 3;
      // Hiring company: aggregator jobs carry it per-job; company sources use the label.
      const who = job.company ?? sourceLabel(source);
      const dept = job.department ? ` · ${job.department}` : "";
      console.log(`  [T${tier}] ${who} — ${job.title}`);
      console.log(`        ${job.location}${dept}`);
      console.log(`        ${job.url}`);
    }
    console.log("");
  },
};
```

- [ ] **Step 9: Update `src/config.ts` (rename loader to sources, back-compat `kind`)**

Replace the whole file:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Source } from "./core/types.js";

/**
 * Load sources from JSON. Entries without an explicit `kind` default to
 * "company" so the pre-hybrid targets.json shape still parses. Full zod
 * validation arrives later; for now we only guard against a malformed file.
 */
export function loadSources(path = "sources.json"): Source[] {
  const abs = resolve(process.cwd(), path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Could not read/parse ${abs}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${abs} must contain a JSON array of sources`);
  }
  return parsed.map((entry) => {
    const e = entry as Record<string, unknown>;
    return (e.kind === undefined ? { ...e, kind: "company" } : e) as Source;
  });
}
```

(Note: `src/index.ts` still imports `loadTargets`; it is updated in this step too — change its import to `loadSources` and pass `sources: loadSources()` to `poll`. See Step 10.)

- [ ] **Step 10: Update `src/index.ts` to the new config + poll shape**

In `src/index.ts`, change the import `loadTargets` → `loadSources` and the `poll({...})` call to pass `sources: loadSources()` instead of `targets: loadTargets()`:

```ts
import { loadSources } from "./config.js";
```
```ts
    await poll({
      sources: loadSources(),
      http: createHttpClient(),
      store,
      notifier: consoleNotifier,
    });
```

- [ ] **Step 11: Update `test/poll.test.ts` for the `Source`/`sources` rename**

In `test/poll.test.ts`: rename the `poll({ targets: [...] })` calls to `poll({ sources: [...] })`; give each `Target` literal `kind: "company"`; and update any `.target` reads on captured notifications to `.source`. The `httpFor(...)` helper, `capturingNotifier`, and the failure-isolation test's assertions stay the same except for those renames. Example of an updated target literal:

```ts
const a: Source = { kind: "company", company: "A", ats: "greenhouse", token: "a", tier: 1 };
```
Update the import to `import type { HttpClient, Notification, Notifier, Source } from "../src/core/types.js";`. Any assertion like `second[0]?.target.company` becomes `second[0]?.source` with a `sourceLabel(...)`/company check as appropriate (e.g. assert `second.map((n) => n.job.id)` unchanged; where company was asserted, use `sourceLabel(n.source)`).

- [ ] **Step 12: Run the full suite + typecheck**

Run: `npx vitest run`
Expected: PASS — util, state, poll all green (company behavior unchanged).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 13: Commit**

```bash
git add src/ test/util.test.ts test/poll.test.ts
git commit -m "refactor: generalize Target into a Source union (company + query kinds)"
```

---

### Task 2: Adzuna query adapter

**Files:**
- Create: `src/adapters/adzuna.ts`, `test/adzuna.test.ts`
- Modify: `src/adapters/index.ts` (register adzuna)

**Interfaces:**
- Consumes: `QueryAdapter`, `QuerySource`, `Job`, `HttpClient`.
- Produces: `adzunaAdapter: QueryAdapter` fetching `https://api.adzuna.com/v1/api/jobs/{country}/search/1` with `app_id`/`app_key` from env; registered under `queryRegistry.adzuna`.

- [ ] **Step 1: Write `test/adzuna.test.ts` (RED)**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { adzunaAdapter } from "../src/adapters/adzuna.js";
import type { HttpClient, QuerySource } from "../src/core/types.js";

const source: QuerySource = {
  kind: "query", provider: "adzuna",
  query: "ML Engineer", where: "Remote", country: "us", label: "ML remote",
};

function fakeHttp(payload: unknown): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T> {
      // record the URL for assertion via a thrown-free side channel:
      (fakeHttp as unknown as { lastUrl?: string }).lastUrl = url;
      return payload as T;
    },
    async postJson<T>(): Promise<T> { throw new Error("unused"); },
  };
}

const OLD = { id: process.env.ADZUNA_APP_ID, key: process.env.ADZUNA_APP_KEY };
afterEach(() => {
  if (OLD.id === undefined) delete process.env.ADZUNA_APP_ID; else process.env.ADZUNA_APP_ID = OLD.id;
  if (OLD.key === undefined) delete process.env.ADZUNA_APP_KEY; else process.env.ADZUNA_APP_KEY = OLD.key;
});

describe("adzunaAdapter", () => {
  it("normalizes results and carries the hiring company per job", async () => {
    process.env.ADZUNA_APP_ID = "id1";
    process.env.ADZUNA_APP_KEY = "key1";
    const payload = {
      results: [
        { id: "111", title: "ML Engineer", redirect_url: "https://adzuna/111",
          location: { display_name: "Remote (US)" }, company: { display_name: "Acme AI" },
          created: "2026-07-20T00:00:00Z" },
        { id: "222", title: "Senior ML Engineer", redirect_url: "https://adzuna/222",
          location: {}, company: {} },
      ],
    };
    const jobs = await adzunaAdapter.fetchJobs(source, fakeHttp(payload));
    expect(jobs).toEqual([
      { id: "111", title: "ML Engineer", url: "https://adzuna/111", location: "Remote (US)", company: "Acme AI", postedAt: "2026-07-20T00:00:00Z" },
      { id: "222", title: "Senior ML Engineer", url: "https://adzuna/222", location: "Unspecified" },
    ]);
    const url = (fakeHttp as unknown as { lastUrl?: string }).lastUrl ?? "";
    expect(url).toContain("/jobs/us/search/1");
    expect(url).toContain("app_id=id1");
    expect(url).toContain("app_key=key1");
    expect(url).toContain("what=ML+Engineer");   // or URL-encoded equivalent
    expect(url).toContain("where=Remote");
  });

  it("throws a clear error when API keys are missing", async () => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    await expect(adzunaAdapter.fetchJobs(source, fakeHttp({ results: [] }))).rejects.toThrow(/ADZUNA_APP_ID/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/adzuna.test.ts`
Expected: FAIL — cannot find `../src/adapters/adzuna.js`.

- [ ] **Step 3: Write `src/adapters/adzuna.ts`**

```ts
import type { HttpClient, Job, QueryAdapter, QuerySource } from "../core/types.js";

// Fields we consume from the Adzuna Search API.
// Endpoint: GET api.adzuna.com/v1/api/jobs/{country}/search/1?app_id=..&app_key=..&what=..&where=..
interface AdzunaJob {
  id: string | number;
  title: string;
  redirect_url: string;
  location?: { display_name?: string } | null;
  company?: { display_name?: string } | null;
  created?: string | null;
}

interface AdzunaResponse {
  results: AdzunaJob[];
}

function normalize(raw: AdzunaJob): Job {
  const company = raw.company?.display_name?.trim();
  return {
    id: String(raw.id),
    title: raw.title,
    url: raw.redirect_url,
    location: raw.location?.display_name?.trim() || "Unspecified",
    ...(company ? { company } : {}),
    ...(raw.created ? { postedAt: raw.created } : {}),
  };
}

export const adzunaAdapter: QueryAdapter = {
  provider: "adzuna",
  async fetchJobs(source: QuerySource, http: HttpClient): Promise<Job[]> {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      throw new Error("Missing ADZUNA_APP_ID / ADZUNA_APP_KEY environment variables");
    }
    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      what: source.query,
      where: source.where,
      "content-type": "application/json",
    });
    const url = `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(
      source.country,
    )}/search/1?${params.toString()}`;
    const data = await http.getJson<AdzunaResponse>(url);
    return (data.results ?? []).map(normalize);
  },
};
```

- [ ] **Step 4: Register adzuna in `src/adapters/index.ts`**

Add the import and put adzuna in the query registry:
```ts
import { adzunaAdapter } from "./adzuna.js";
```
```ts
const queryRegistry: Partial<Record<Provider, QueryAdapter>> = {
  adzuna: adzunaAdapter,
};
```

- [ ] **Step 5: Run adzuna tests + full suite + typecheck**

Run: `npx vitest run test/adzuna.test.ts` → PASS (2 tests).
Run: `npx vitest run` → all green.
Run: `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/adzuna.ts src/adapters/index.ts test/adzuna.test.ts
git commit -m "feat: add Adzuna query adapter for cross-company title search"
```

---

### Task 3: Config file + mixed-source poll integration test

**Files:**
- Create: `sources.json`, `sources.example.json`
- Modify: `test/poll.test.ts` (add a mixed company+query test)
- Delete: `targets.json`, `targets.example.json` (superseded)

**Interfaces:**
- Consumes: `loadSources` (Task 1), `adzunaAdapter` (Task 2), `poll`.
- Produces: a `sources.json` the poller reads; a test proving company and query sources dedup/prune together.

- [ ] **Step 1: Create `sources.example.json`**

```json
[
  { "kind": "company", "company": "Stripe", "ats": "greenhouse", "token": "stripe", "tier": 1 },
  { "kind": "company", "company": "Airbnb", "ats": "greenhouse", "token": "airbnb", "tier": 2 },
  { "kind": "query", "provider": "adzuna", "query": "Machine Learning Engineer", "where": "remote", "country": "us", "label": "ML remote", "tier": 1 }
]
```

- [ ] **Step 2: Create `sources.json` (real config)**

```json
[
  { "kind": "company", "company": "Stripe", "ats": "greenhouse", "token": "stripe", "tier": 1 },
  { "kind": "query", "provider": "adzuna", "query": "Machine Learning Engineer", "where": "remote", "country": "us", "label": "ML remote", "tier": 1 }
]
```

- [ ] **Step 3: Remove the superseded company-only config**

```bash
git rm targets.json targets.example.json
```

- [ ] **Step 4: Add a mixed-source poll test (RED first)**

Append to `test/poll.test.ts` inside `describe("poll", ...)`. This reuses the file's `httpFor`, `capturingNotifier`, and `createSqliteStore` helpers; add a query source and make `httpFor` also answer the Adzuna URL. Extend `httpFor` (or add `httpMixed`) so it returns Greenhouse shape for `/boards/` URLs and Adzuna shape for `/api/jobs/` URLs:

```ts
it("polls company and query sources together, deduping each independently", async () => {
  process.env.ADZUNA_APP_ID = "id1";
  process.env.ADZUNA_APP_KEY = "key1";
  const store = createSqliteStore({ path: ":memory:" });
  const company: Source = { kind: "company", company: "Acme", ats: "greenhouse", token: "acme", tier: 1 };
  const query: Source = { kind: "query", provider: "adzuna", query: "ML Engineer", where: "remote", country: "us", label: "ML remote", tier: 1 };

  const http: HttpClient = {
    async getJson<T>(url: string): Promise<T> {
      if (url.includes("/api/jobs/")) {
        return { results: [{ id: "a1", title: "ML Engineer", redirect_url: "https://x/a1", location: { display_name: "Remote" }, company: { display_name: "Startup Inc" } }] } as T;
      }
      return { jobs: [{ id: 1, title: "Backend", absolute_url: "https://x/1", location: { name: "NYC" } }] } as T;
    },
    async postJson<T>(): Promise<T> { throw new Error("unused"); },
  };

  // Run 1: both seed silently.
  const s1: Notification[] = [];
  await poll({ sources: [company, query], http, store, notifier: capturingNotifier(s1) });
  expect(s1).toEqual([]);

  // Run 2: query returns an extra job; company unchanged. Only the new query job notifies.
  const http2: HttpClient = {
    async getJson<T>(url: string): Promise<T> {
      if (url.includes("/api/jobs/")) {
        return { results: [
          { id: "a1", title: "ML Engineer", redirect_url: "https://x/a1", location: { display_name: "Remote" }, company: { display_name: "Startup Inc" } },
          { id: "a2", title: "Senior ML Engineer", redirect_url: "https://x/a2", location: { display_name: "Remote" }, company: { display_name: "BigCo" } },
        ] } as T;
      }
      return { jobs: [{ id: 1, title: "Backend", absolute_url: "https://x/1", location: { name: "NYC" } }] } as T;
    },
    async postJson<T>(): Promise<T> { throw new Error("unused"); },
  };
  const s2: Notification[] = [];
  await poll({ sources: [company, query], http: http2, store, notifier: capturingNotifier(s2) });
  expect(s2.map((n) => n.job.id)).toEqual(["a2"]);
  expect(s2[0]?.job.company).toBe("BigCo");

  store.close();
});
```

Ensure the ADZUNA env is restored in an `afterEach` (add one to this file if not present, mirroring `test/adzuna.test.ts`).

- [ ] **Step 5: Run to verify it passes (adapters already exist from Tasks 1–2)**

Run: `npx vitest run test/poll.test.ts`
Expected: PASS — the mixed test plus the existing poll tests. (This test is GREEN immediately because Tasks 1–2 provide the machinery; it guards cross-kind integration.)

- [ ] **Step 6: Full suite + typecheck + local default-config sanity**

Run: `npx vitest run` → all green.
Run: `npm run typecheck` → clean.
Run: `node -e "import('./src/config.js')" ` is not valid (ts) — instead verify config parses via: `npx tsx -e "import('./src/config.ts').then(m => console.log(m.loadSources().length))"` → prints `2`.

- [ ] **Step 7: Commit**

```bash
git add sources.json sources.example.json test/poll.test.ts
git commit -m "feat: move config to sources.json (company + query) and cover mixed polling"
```

---

### Task 4: Wire Adzuna secrets into CI + update deployment doc

**Files:**
- Modify: `.github/workflows/poll.yml`, `docs/deployment.md`

**Interfaces:**
- Consumes: `adzunaAdapter` reading `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` from env.
- Produces: the hourly workflow passes the two secrets to the run step; the doc explains signup + secrets.

- [ ] **Step 1: Add the secrets to the run step in `.github/workflows/poll.yml`**

In the "Run poller" step, extend `env` (keep `STATE_DB_PATH`):
```yaml
      - name: Run poller
        env:
          STATE_DB_PATH: state-data/state.db
          ADZUNA_APP_ID: ${{ secrets.ADZUNA_APP_ID }}
          ADZUNA_APP_KEY: ${{ secrets.ADZUNA_APP_KEY }}
        run: npm start
```

- [ ] **Step 2: Validate the YAML still parses**

Run: `ruby -ryaml -e "YAML.load_file('.github/workflows/poll.yml'); puts 'YAML OK'"`
Expected: `YAML OK`.

- [ ] **Step 3: Add an Adzuna section to `docs/deployment.md`**

Append:

```markdown
## Title-search (Adzuna) setup

Query sources in `sources.json` (`"kind": "query"`) search across all companies
via Adzuna and need a free API key:

1. Sign up at https://developer.adzuna.com/ and create an app to get an
   **App ID** and **App Key**.
2. Add both as GitHub repo secrets: Settings → Secrets and variables → Actions →
   New repository secret → `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`.
3. For local runs, export them in your shell before `npm start`:
   ```bash
   export ADZUNA_APP_ID=... ADZUNA_APP_KEY=...
   npm start
   ```

Without the keys, query sources log a per-source error and are skipped; company
(ATS board) sources still run normally.
```

- [ ] **Step 4: Confirm scope + commit**

Run: `git status --short` → only `.github/workflows/poll.yml` and `docs/deployment.md` changed.
```bash
git add .github/workflows/poll.yml docs/deployment.md
git commit -m "feat: pass Adzuna API keys to the scheduled workflow; document setup"
```

---

## Self-Review

**Spec coverage (against the approved plan):**
- Generalize `Target`→`Source` union, `Job.company`, adapter split, `Notification.source` → Task 1. ✓
- Adzuna adapter (env keys, normalize, graceful missing-key throw) → Task 2. ✓
- `sourceKeyOf` query keys stable across label renames; `sourceLabel` → Task 1 (tested). ✓
- Poll dispatch on kind; okSources/scoped-prune/batched-notify reused → Task 1 poll rewrite + Task 3 mixed test. ✓
- Config `sources.json` with back-compat `kind` default → Task 1 (`loadSources`) + Task 3 (files). ✓
- Console notifier shows `job.company ?? sourceLabel` → Task 1. ✓
- CI secrets + deployment doc → Task 4. ✓
- Reused unchanged: `state.ts`, `http.ts`, workflow persistence mechanics — no tasks touch them. ✓

**Placeholder scan:** No TBD/TODO; every code, YAML, JSON, and command step is concrete.

**Type consistency:** `Source`/`CompanySource`/`QuerySource`/`Provider`, `CompanyAdapter.fetchJobs(CompanySource)`, `QueryAdapter.fetchJobs(QuerySource)`, `Notification.source`, `sourceKeyOf(Source)`, `sourceLabel(Source)`, `tokenOf(CompanySource)`, `loadSources()`, and `poll({ sources })` are used identically across Tasks 1–4 and their tests. Greenhouse `Job.id = String(raw.id)` and Adzuna `Job.id = String(raw.id)` both satisfy `Job.id: string` for dedup.
```
