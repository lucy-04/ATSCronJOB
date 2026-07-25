# Phase 5 — Ashby Adapter + Seed Ashby Companies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an Ashby ATS adapter so the poller can reach the AI/tech companies that are NOT on Greenhouse (OpenAI, Cohere, Notion, Ramp, Plaid, Perplexity, Benchling, Linear), and seed them into `sources.json`.

**Architecture:** Ashby is a token/slug-based company ATS, so it slots into the existing `SimpleSource` (`ats:"ashby"`, `token`) and `CompanyAdapter` pattern with zero type or util changes — a near-mirror of `src/adapters/greenhouse.ts`. The role filter, dedup/prune engine, config, and cron are all reused untouched.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, vitest, tsx.

**Research (live, 2026-07-26):** Ashby public job-board API `GET https://api.ashbyhq.com/posting-api/job-board/{token}` returns `{ jobs: [...], apiVersion }`. Each job: `id` (string uuid), `title`, `location` (string|null), `jobUrl`, `applyUrl`, `department` (string|null), `team`, `employmentType`, `isRemote` (bool|null), `publishedAt` (ISO|null), `isListed` (bool). Verified job counts: openai 753, cohere 137, notion 127, ramp 118, plaid 115, perplexity 86, benchling 53, linear 25. Lever was probed too but its live boards (netflix, plaid) returned empty arrays — deferred.

## Global Constraints

- Node >= 20; ESM (`"type":"module"`) — relative imports use `.js` extensions; `import type` for type-only imports (`verbatimModuleSyntax`).
- No new dependencies.
- Tests under `test/`, run with `npx vitest run`; `npm run typecheck` stays clean (strict, `noUncheckedIndexedAccess`).
- The adapter is a `CompanyAdapter` with `ats:"ashby"`; it uses the injected `HttpClient` (no direct fetch) and `tokenOf(source)` for the slug.
- `normalize()` maps: `id`→`String(id)` (dedup identity), `title`→`title`, `url`→`jobUrl ?? applyUrl`, `location`→`location.trim()` or (`isRemote` ? "Remote" : "Unspecified"), `department` when present, `postedAt`→`publishedAt` when present. Skip jobs with `isListed === false`.
- Seeded tokens must be live-verified (HTTP 200 with a non-empty `jobs` array) at seed time. `sources.json` stays committed config.

---

### Task 1: Ashby adapter

**Files:**
- Create: `src/adapters/ashby.ts`, `test/ashby.test.ts`
- Modify: `src/adapters/index.ts` (register the adapter)

**Interfaces:**
- Consumes: `CompanyAdapter, HttpClient, Job, CompanySource` from `../core/types.js`; `tokenOf` from `./util.js`.
- Produces: `export const ashbyAdapter: CompanyAdapter` (`ats:"ashby"`), registered in `companyRegistry`.

- [ ] **Step 1: Write `test/ashby.test.ts` (RED)**

```ts
import { describe, it, expect } from "vitest";
import { ashbyAdapter } from "../src/adapters/ashby.js";
import type { CompanySource, HttpClient } from "../src/core/types.js";

const source: CompanySource = { kind: "company", company: "OpenAI", ats: "ashby", token: "openai", tier: 1 };

// Fake HTTP returning a recorded Ashby-shaped payload; postJson is unused.
function fakeHttp(payload: unknown, capture?: (url: string) => void): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T> {
      capture?.(url);
      return payload as T;
    },
    async postJson<T>(): Promise<T> {
      throw new Error("postJson not used by Ashby");
    },
  };
}

describe("ashbyAdapter", () => {
  it("hits the job-board posting API with the token", async () => {
    let seen = "";
    const http = fakeHttp({ jobs: [] }, (u) => (seen = u));
    await ashbyAdapter.fetchJobs(source, http);
    expect(seen).toBe("https://api.ashbyhq.com/posting-api/job-board/openai");
  });

  it("normalizes id, title, url, location, department, postedAt", async () => {
    const http = fakeHttp({
      jobs: [
        {
          id: "abc-123",
          title: "Backend Engineer",
          location: "San Francisco",
          department: "Engineering",
          jobUrl: "https://jobs.ashbyhq.com/openai/abc-123",
          applyUrl: "https://jobs.ashbyhq.com/openai/abc-123/application",
          isRemote: null,
          isListed: true,
          publishedAt: "2026-03-12T16:38:15.322+00:00",
        },
      ],
    });
    const jobs = await ashbyAdapter.fetchJobs(source, http);
    expect(jobs).toEqual([
      {
        id: "abc-123",
        title: "Backend Engineer",
        url: "https://jobs.ashbyhq.com/openai/abc-123",
        location: "San Francisco",
        department: "Engineering",
        postedAt: "2026-03-12T16:38:15.322+00:00",
      },
    ]);
  });

  it("falls back to applyUrl when jobUrl is absent, and marks remote/unspecified location", async () => {
    const http = fakeHttp({
      jobs: [
        { id: "r1", title: "AI Engineer", location: null, isRemote: true, isListed: true, applyUrl: "https://jobs.ashbyhq.com/openai/r1/application" },
        { id: "u1", title: "Data Scientist", location: "  ", isRemote: null, isListed: true, jobUrl: "https://jobs.ashbyhq.com/openai/u1" },
      ],
    });
    const jobs = await ashbyAdapter.fetchJobs(source, http);
    expect(jobs[0]).toMatchObject({ id: "r1", url: "https://jobs.ashbyhq.com/openai/r1/application", location: "Remote" });
    expect(jobs[1]).toMatchObject({ id: "u1", location: "Unspecified" });
  });

  it("skips unlisted jobs (isListed === false)", async () => {
    const http = fakeHttp({
      jobs: [
        { id: "keep", title: "Backend Engineer", location: "NYC", isListed: true, jobUrl: "https://x/keep" },
        { id: "drop", title: "Hidden Role", location: "NYC", isListed: false, jobUrl: "https://x/drop" },
      ],
    });
    const jobs = await ashbyAdapter.fetchJobs(source, http);
    expect(jobs.map((j) => j.id)).toEqual(["keep"]);
  });

  it("tolerates a missing jobs array", async () => {
    const http = fakeHttp({});
    expect(await ashbyAdapter.fetchJobs(source, http)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/ashby.test.ts`
Expected: FAIL — cannot find `../src/adapters/ashby.js`.

- [ ] **Step 3: Write `src/adapters/ashby.ts`**

```ts
import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";
import { tokenOf } from "./util.js";

// Fields we consume from the Ashby public job-board posting API.
// Endpoint: GET https://api.ashbyhq.com/posting-api/job-board/{token}
interface AshbyJob {
  id: string;
  title: string;
  location?: string | null;
  department?: string | null;
  jobUrl?: string | null;
  applyUrl?: string | null;
  isRemote?: boolean | null;
  isListed?: boolean;
  publishedAt?: string | null;
}

interface AshbyResponse {
  jobs?: AshbyJob[];
}

function normalize(raw: AshbyJob): Job {
  const location = raw.location?.trim() || (raw.isRemote ? "Remote" : "Unspecified");
  return {
    id: String(raw.id),
    title: raw.title,
    url: raw.jobUrl ?? raw.applyUrl ?? "",
    location,
    ...(raw.department ? { department: raw.department } : {}),
    ...(raw.publishedAt ? { postedAt: raw.publishedAt } : {}),
  };
}

export const ashbyAdapter: CompanyAdapter = {
  ats: "ashby",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(tokenOf(source))}`;
    const data = await http.getJson<AshbyResponse>(url);
    return (data.jobs ?? []).filter((j) => j.isListed !== false).map(normalize);
  },
};
```

- [ ] **Step 4: Register in `src/adapters/index.ts`**

Add the import and the registry entry:
```ts
import { ashbyAdapter } from "./ashby.js";
```
```ts
const companyRegistry: Partial<Record<Ats, CompanyAdapter>> = {
  greenhouse: greenhouseAdapter,
  ashby: ashbyAdapter,
};
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `npx vitest run test/ashby.test.ts` → PASS (all).
Run: `npx vitest run` → full suite green.
Run: `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/ashby.ts test/ashby.test.ts src/adapters/index.ts
git commit -m "feat: add Ashby ATS adapter"
```

---

### Task 2: Seed Ashby companies into sources.json

**Files:**
- Modify: `sources.json`, `docs/deployment.md`

**Interfaces:**
- Consumes: the live Ashby posting API (public) to verify tokens; the existing Greenhouse entries stay.
- Produces: `sources.json` gains verified `ats:"ashby"` company entries.

- [ ] **Step 1: Verify candidate Ashby tokens live**

Run (public API, no auth) — keep only tokens whose `jobs` array is non-empty:
```bash
for t in openai cohere notion ramp plaid perplexity benchling linear; do
  n=$(curl -s "https://api.ashbyhq.com/posting-api/job-board/$t" | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log((d.jobs||[]).length)}catch(e){console.log('ERR')}")
  echo "$n  $t"
done
```
Record which returned a positive count. Only those get added.

- [ ] **Step 2: Append verified Ashby entries to `sources.json`**

Keep the existing 16 Greenhouse company entries. Append the confirmed Ashby ones, AI-first companies tier 1 (openai, cohere, perplexity), the rest tier 2. Shape per entry:
```json
{ "kind": "company", "company": "OpenAI", "ats": "ashby", "token": "openai", "tier": 1 }
```
Add ONLY tokens confirmed non-empty in Step 1. Do not remove or reorder the Greenhouse entries.

- [ ] **Step 3: Sanity-check the config loads and dispatches**

Run: `npx tsx -e "import('./src/config.ts').then(m => { const s = m.loadSources(); const ats = new Set(s.map(x => x.kind==='company' ? x.ats : x.kind)); console.log(s.length, [...ats]); })"`
Expected: prints the total count and an array containing both `greenhouse` and `ashby`.

- [ ] **Step 4: Note Ashby support in `docs/deployment.md`**

Append under the sources documentation:
```markdown
## Supported ATSes

- **Greenhouse** — `"ats":"greenhouse"`, `token` = board slug (`boards-api.greenhouse.io/v1/boards/{token}/jobs`).
- **Ashby** — `"ats":"ashby"`, `token` = job-board slug (`api.ashbyhq.com/posting-api/job-board/{token}`). This is where many AI-first companies post (OpenAI, Cohere, Notion, Ramp, Perplexity, …).

Both are public, key-less APIs. A wrong/renamed token surfaces on the next run as
`! <Company> failed: … 404 …` without aborting the run — fix or remove the entry.
```

- [ ] **Step 5: Commit**

```bash
git add sources.json docs/deployment.md
git commit -m "feat: seed sources.json with verified Ashby AI/tech companies"
```

---

## Self-Review

**Spec coverage:**
- Ashby adapter mirroring the CompanyAdapter pattern, HttpClient-injected, tokenOf-based URL → Task 1. ✓
- normalize field mapping incl. jobUrl/applyUrl fallback, remote/unspecified location, isListed skip, missing-jobs tolerance → Task 1 tests. ✓
- Registered so `poll`/`supportedAtses` dispatch to it → Task 1 Step 4. ✓
- Seed verified Ashby companies, Greenhouse entries preserved → Task 2. ✓
- No type/util changes needed (ashby already in SimpleSource union) → confirmed, nothing to do. ✓

**Placeholder scan:** none. Task 2's final list is determined by the Step-1 live check.

**Type consistency:** `ashbyAdapter: CompanyAdapter` with `ats:"ashby"`; `AshbyJob`/`AshbyResponse` local; `normalize(raw): Job`. Uses `tokenOf`/registry exactly as greenhouse does.
