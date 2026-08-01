# Workday Adapter (India via searchText) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a Workday ATS adapter (the 5th adapter) that polls the public Workday Candidate-Experience (CxS) API, filtered to India via `searchText`, and seed ~11 India-GCC companies (~1,100 India roles) — the largest India unlock available. On `main` (production).

**Architecture:** Workday is a "tenant-class" ATS: each company is identified by `tenant`/`dc`/`site` (already the `WorkdaySource` shape in `types.ts`), not a single slug. The adapter POSTs to `https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with `{appliedFacets:{},limit,offset,searchText}`, paginates, and normalizes. India focus is `searchText:"India"` per source. The dedup/filter/prune/notify engine is reused unchanged.

**Tech Stack:** TypeScript (ESM, strict), vitest. Uses the existing injected `HttpClient.postJson`.

**Research (live 2026-08-01):** CxS returns `{total, jobPostings:[{title, externalPath, locationsText, bulletFields}]}`. `id` = `bulletFields[0]` (req number, e.g. `JR2020803`). Job URL = `https://{tenant}.{dc}.myworkdayjobs.com/en-US/{site}{externalPath}` (verified HTTP 200). Pagination: `limit` 20, `offset` steps. `searchText:"India"` filters to India-relevant roles (mildly fuzzy — includes some multi-location roles). No aggressive rate-limiting observed.

## Global Constraints

- Node >= 20; ESM (`verbatimModuleSyntax`): `.js` relative imports, `import type` for types. No new dependencies.
- Tests under `test/`, `npx vitest run`; `npm run typecheck` clean (strict, `noUncheckedIndexedAccess`).
- The adapter is a `CompanyAdapter` with `ats:"workday"`; uses the injected `HttpClient` (no direct fetch). It does NOT use `tokenOf` (Workday has no token; it uses `tenant`/`dc`/`site`).
- `normalize`: `id`→`bulletFields?.[0] ?? externalPath`, `title`→`title`, `url`→`https://{tenant}.{dc}.myworkdayjobs.com/en-US/{site}{externalPath}`, `location`→`locationsText?.trim() || "India"`. No `postedAt` (Workday only gives relative text like "Posted Yesterday").
- Pagination cap: stop at `offset >= total`, an empty page, or `MAX_PAGES = 25` (≤500 jobs) — whichever first.
- Seeded coordinates must be live-verified (India `total` > 0) at seed time.

---

### Task 1: Workday adapter

**Files:**
- Modify: `src/core/types.ts` (add `searchText?` to `WorkdaySource`), `src/adapters/index.ts` (register)
- Create: `src/adapters/workday.ts`, `test/workday.test.ts`

**Interfaces:**
- Consumes: `CompanyAdapter, HttpClient, Job, CompanySource` from `../core/types.js`.
- Produces: `export const workdayAdapter: CompanyAdapter` (`ats:"workday"`), registered in `companyRegistry`.

- [ ] **Step 1: Add `searchText?` to `WorkdaySource` in `src/core/types.ts`**

In the `WorkdaySource` interface, add:
```ts
  /** Optional Workday CxS free-text search; set to "India" to scope a source to India roles. */
  searchText?: string;
```

- [ ] **Step 2: Write `test/workday.test.ts` (RED)**

```ts
import { describe, it, expect } from "vitest";
import { workdayAdapter } from "../src/adapters/workday.js";
import type { CompanySource, HttpClient } from "../src/core/types.js";

const source: CompanySource = {
  kind: "company", company: "NVIDIA", ats: "workday",
  tenant: "nvidia", dc: "wd5", site: "NVIDIAExternalCareerSite", searchText: "India", tier: 1,
};

// Fake HTTP whose postJson returns paginated Workday CxS payloads keyed by offset.
function pagedHttp(pages: Record<number, { total: number; jobPostings: unknown[] }>, calls: { url: string; body: any }[]): HttpClient {
  return {
    async getJson<T>(): Promise<T> { throw new Error("getJson not used by Workday"); },
    async postJson<T>(url: string, body: unknown): Promise<T> {
      calls.push({ url, body: body as any });
      const offset = (body as any).offset as number;
      return (pages[offset] ?? { total: pages[0]!.total, jobPostings: [] }) as T;
    },
  };
}
function wdJob(id: string, path: string, loc: string) {
  return { title: "Backend Engineer " + id, externalPath: path, locationsText: loc, bulletFields: [id] };
}

describe("workdayAdapter", () => {
  it("POSTs to the CxS endpoint with searchText and paginates", async () => {
    const calls: { url: string; body: any }[] = [];
    const http = pagedHttp({
      0: { total: 25, jobPostings: Array.from({ length: 20 }, (_, i) => wdJob("A" + i, "/job/India-Pune/A" + i, "India, Pune")) },
      20: { total: 25, jobPostings: Array.from({ length: 5 }, (_, i) => wdJob("B" + i, "/job/India-Bengaluru/B" + i, "India, Bengaluru")) },
    }, calls);
    const jobs = await workdayAdapter.fetchJobs(source, http);
    expect(jobs).toHaveLength(25); // 20 + 5 across two pages
    expect(calls[0]!.url).toBe("https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs");
    expect(calls[0]!.body).toEqual({ appliedFacets: {}, limit: 20, offset: 0, searchText: "India" });
    expect(calls[1]!.body.offset).toBe(20); // second page requested
  });

  it("normalizes id (bulletFields[0]), url, title, location", async () => {
    const calls: { url: string; body: any }[] = [];
    const http = pagedHttp({ 0: { total: 1, jobPostings: [wdJob("JR123", "/job/India-Mumbai/Senior_JR123", "India, Mumbai")] } }, calls);
    const jobs = await workdayAdapter.fetchJobs(source, http);
    expect(jobs[0]).toEqual({
      id: "JR123",
      title: "Backend Engineer JR123",
      url: "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/India-Mumbai/Senior_JR123",
      location: "India, Mumbai",
    });
  });

  it("falls back to externalPath for id and 'India' for a blank location", async () => {
    const calls: { url: string; body: any }[] = [];
    const http = pagedHttp({ 0: { total: 1, jobPostings: [{ title: "T", externalPath: "/job/x/T_JR9", locationsText: "  " }] } }, calls);
    const jobs = await workdayAdapter.fetchJobs(source, http);
    expect(jobs[0]!.id).toBe("/job/x/T_JR9");
    expect(jobs[0]!.location).toBe("India");
  });

  it("stops on an empty page and tolerates missing jobPostings", async () => {
    const calls: { url: string; body: any }[] = [];
    const http = pagedHttp({ 0: { total: 100, jobPostings: [] } }, calls);
    const jobs = await workdayAdapter.fetchJobs(source, http);
    expect(jobs).toEqual([]);
    expect(calls).toHaveLength(1); // did not keep paging past the empty page
  });

  it("defaults searchText to empty string when the source omits it", async () => {
    const calls: { url: string; body: any }[] = [];
    const noSearch: CompanySource = { kind: "company", company: "X", ats: "workday", tenant: "x", dc: "wd1", site: "S" };
    const http = pagedHttp({ 0: { total: 0, jobPostings: [] } }, calls);
    await workdayAdapter.fetchJobs(noSearch, http);
    expect(calls[0]!.body.searchText).toBe("");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/workday.test.ts` → FAIL (module not found).

- [ ] **Step 4: Write `src/adapters/workday.ts`**

```ts
import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";

// Fields we consume from the Workday Candidate-Experience (CxS) API.
// Endpoint: POST https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
interface WorkdayJob {
  title: string;
  externalPath: string;
  locationsText?: string | null;
  bulletFields?: string[] | null;
}

interface WorkdayResponse {
  total?: number;
  jobPostings?: WorkdayJob[];
}

const PAGE = 20;
const MAX_PAGES = 25; // cap at ~500 jobs/source per run

function normalize(raw: WorkdayJob, base: string, site: string): Job {
  const id = raw.bulletFields?.[0] ?? raw.externalPath;
  return {
    id: String(id),
    title: raw.title,
    url: `${base}/en-US/${site}${raw.externalPath}`,
    location: raw.locationsText?.trim() || "India",
  };
}

export const workdayAdapter: CompanyAdapter = {
  ats: "workday",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    if (source.ats !== "workday") {
      throw new Error(`workdayAdapter received a non-workday source (${source.ats})`);
    }
    const { tenant, dc, site } = source;
    const searchText = source.searchText ?? "";
    const base = `https://${tenant}.${dc}.myworkdayjobs.com`;
    const url = `${base}/wday/cxs/${tenant}/${site}/jobs`;

    const jobs: Job[] = [];
    let offset = 0;
    let total = Infinity;
    for (let page = 0; page < MAX_PAGES && offset < total; page++) {
      const data = await http.postJson<WorkdayResponse>(url, {
        appliedFacets: {},
        limit: PAGE,
        offset,
        searchText,
      });
      const postings = data.jobPostings ?? [];
      if (postings.length === 0) break;
      for (const p of postings) jobs.push(normalize(p, base, site));
      total = typeof data.total === "number" ? data.total : jobs.length;
      offset += PAGE;
    }
    return jobs;
  },
};
```

- [ ] **Step 5: Register in `src/adapters/index.ts`**

Add the import and the registry entry (keep greenhouse/ashby/lever/smartrecruiters):
```ts
import { workdayAdapter } from "./workday.js";
```
```ts
const companyRegistry: Partial<Record<Ats, CompanyAdapter>> = {
  greenhouse: greenhouseAdapter,
  ashby: ashbyAdapter,
  lever: leverAdapter,
  smartrecruiters: smartRecruitersAdapter,
  workday: workdayAdapter,
};
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/workday.test.ts` → PASS (5).
Run: `npx vitest run` → full suite green.
Run: `npm run typecheck` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/adapters/workday.ts src/adapters/index.ts test/workday.test.ts
git commit -m "feat: add Workday ATS adapter (CxS API, paginated, searchText-scoped)"
```

---

### Task 2: Seed India-GCC Workday companies

**Files:**
- Modify: `sources.json`, `docs/deployment.md`

**Interfaces:**
- Consumes: the live Workday CxS API to re-verify each company's India `total`.

- [ ] **Step 1: Re-verify each coordinate live (keep India total > 0)**

```bash
wd () { curl -s --max-time 10 -X POST "https://$1.$2.myworkdayjobs.com/wday/cxs/$1/$3/jobs" -H "content-type: application/json" -d '{"appliedFacets":{},"limit":1,"offset":0,"searchText":"India"}' | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(typeof d.total==='number'?d.total:0)}catch(e){console.log(0)}"; }
for spec in "salesforce:wd12:External_Career_Site" "nvidia:wd5:NVIDIAExternalCareerSite" "mastercard:wd1:CorporateCareers" "adobe:wd5:external_experienced" "ebay:wd5:apply" "autodesk:wd1:Ext" "blackrock:wd1:BlackRock_Professional" "workday:wd5:Workday" "comcast:wd5:Comcast_Careers" "broadcom:wd1:External_Career" "paypal:wd1:jobs"; do
  IFS=: read t d s <<< "$spec"; echo "$(wd $t $d $s)  $t $d $s"
done
```
Keep only entries with a positive count.

- [ ] **Step 2: Append verified Workday entries to `sources.json`**

Keep the existing 118 entries intact and in order. Append these (all with `searchText:"India"`), dropping any that verified 0 in Step 1. Shape:
```json
  { "kind": "company", "company": "Salesforce (India)", "ats": "workday", "tenant": "salesforce", "dc": "wd12", "site": "External_Career_Site", "searchText": "India", "tier": 1 },
  { "kind": "company", "company": "NVIDIA (India)", "ats": "workday", "tenant": "nvidia", "dc": "wd5", "site": "NVIDIAExternalCareerSite", "searchText": "India", "tier": 1 },
  { "kind": "company", "company": "Mastercard (India)", "ats": "workday", "tenant": "mastercard", "dc": "wd1", "site": "CorporateCareers", "searchText": "India", "tier": 2 },
  { "kind": "company", "company": "Adobe (India)", "ats": "workday", "tenant": "adobe", "dc": "wd5", "site": "external_experienced", "searchText": "India", "tier": 1 },
  { "kind": "company", "company": "eBay (India)", "ats": "workday", "tenant": "ebay", "dc": "wd5", "site": "apply", "searchText": "India", "tier": 2 },
  { "kind": "company", "company": "Autodesk (India)", "ats": "workday", "tenant": "autodesk", "dc": "wd1", "site": "Ext", "searchText": "India", "tier": 2 },
  { "kind": "company", "company": "BlackRock (India)", "ats": "workday", "tenant": "blackrock", "dc": "wd1", "site": "BlackRock_Professional", "searchText": "India", "tier": 2 },
  { "kind": "company", "company": "Workday (India)", "ats": "workday", "tenant": "workday", "dc": "wd5", "site": "Workday", "searchText": "India", "tier": 2 },
  { "kind": "company", "company": "Comcast (India)", "ats": "workday", "tenant": "comcast", "dc": "wd5", "site": "Comcast_Careers", "searchText": "India", "tier": 3 },
  { "kind": "company", "company": "Broadcom (India)", "ats": "workday", "tenant": "broadcom", "dc": "wd1", "site": "External_Career", "searchText": "India", "tier": 3 },
  { "kind": "company", "company": "PayPal (India)", "ats": "workday", "tenant": "paypal", "dc": "wd1", "site": "jobs", "searchText": "India", "tier": 3 }
```

- [ ] **Step 3: Verify structure**

Run: `npx tsx -e "import('./src/config.ts').then(m => { const s = m.loadSources(); const ats = new Set(s.map(x => x.kind==='company' ? x.ats : x.kind)); console.log(s.length, [...ats].sort()); })"`
Expected: ~129 and an array including `workday`.

Run a dup-key check (Workday key = `workday:{tenant}:{site}`):
```bash
npx tsx -e "import('fs').then(fs => { const s = JSON.parse(fs.readFileSync('sources.json','utf8')); const k = s.map(x => x.ats==='workday' ? 'workday:'+x.tenant+':'+x.site : x.ats+':'+(x.token||'')+':'+(x.country||'')); const d = k.filter((v,i,a)=>a.indexOf(v)!==i); console.log('dupes:', d.length?d:'none'); })"
```
Expected: `dupes: none`.

- [ ] **Step 4: Add a Workday bullet to `docs/deployment.md`** (under the Supported ATSes list):
```markdown
- **Workday** — `"ats":"workday"` with `tenant`/`dc`/`site` (from the careers URL, e.g. `nvidia.wd5.myworkdayjobs.com/.../NVIDIAExternalCareerSite`) and optional `searchText` (set `"India"` to scope to India roles). Public CxS API (`/wday/cxs/{tenant}/{site}/jobs`), paginated; up to 500 postings per source.
```

- [ ] **Step 5: Full suite + typecheck + commit**

Run: `npx vitest run` → green. `npm run typecheck` → clean.
```bash
git add sources.json docs/deployment.md
git commit -m "feat: seed India-GCC Workday companies (Salesforce, NVIDIA, Mastercard, Adobe, ...)"
```

---

## Self-Review

**Spec coverage:**
- Workday adapter (CxS POST, paginate, searchText) → Task 1. ✓
- India via `searchText:"India"` → `WorkdaySource.searchText` + seed entries. ✓
- normalize (bulletFields id, en-US URL, locationsText/India) → Task 1 tests. ✓
- Registered so `poll`/`supportedAtses` dispatch → Task 1 Step 5. ✓
- Seed verified India-GCC companies, existing 118 preserved → Task 2. ✓
- No `tokenOf`/`sourceKeyOf` change (workday already handled in sourceKeyOf as `workday:{tenant}:{site}`; adapter reads tenant/dc/site directly). ✓

**Placeholder scan:** none. Task 2's final list is the Step-1 live re-verification.

**Type consistency:** `workdayAdapter: CompanyAdapter` (`ats:"workday"`); `WorkdayJob`/`WorkdayResponse` local; `normalize(raw, base, site)`. `WorkdaySource.searchText?` read in the adapter and set in every seeded entry.
