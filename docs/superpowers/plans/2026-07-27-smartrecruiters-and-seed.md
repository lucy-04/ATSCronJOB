# Phase 8 — SmartRecruiters Adapter + Big Company Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a SmartRecruiters ATS adapter (fourth ATS) and substantially widen coverage by seeding many verified companies across Greenhouse, Ashby, and SmartRecruiters.

**Architecture:** SmartRecruiters is a token/slug-based company ATS already present in the `Ats`/`SimpleSource` unions, so the adapter slots into the existing `CompanyAdapter` pattern with zero type/util changes — a sibling of `greenhouse.ts`/`ashby.ts`/`lever.ts`. The role filter, dedup/prune engine, notifiers, config, and cron are reused untouched.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, vitest, tsx.

**Research (live, 2026-07-27):** SmartRecruiters posting API `GET https://api.smartrecruiters.com/v1/companies/{token}/postings?limit=100` returns `{ offset, limit, totalFound, content: [...] }`. Each posting: `id` (string), `name` (the title), `releasedDate` (ISO string), `location: { city, region, country, remote, hybrid, fullLocation }`, `department: { id, label }`, `company: { identifier, name }`. There is no per-posting URL field; the canonical public URL is `https://jobs.smartrecruiters.com/{token}/{id}` (verified HTTP 200). Company identifiers are case-sensitive PascalCase. Verified totalFound: Experian 499, ServiceNow 452, NielsenIQ 405, WesternDigital 279, Visa 2, WeWork 2. `limit=100` is the max page size; v1 fetches page 1 only (documented limitation, same as Adzuna).

## Global Constraints

- Node >= 20; ESM (`"type":"module"`) — relative imports use `.js` extensions; `import type` for type-only imports (`verbatimModuleSyntax`).
- No new dependencies.
- Tests under `test/`, run with `npx vitest run`; `npm run typecheck` stays clean (strict, `noUncheckedIndexedAccess`).
- The adapter is a `CompanyAdapter` with `ats:"smartrecruiters"`; it uses the injected `HttpClient` (no direct fetch) and `tokenOf(source)` for the slug.
- `normalize(raw, token)` maps: `id`→`String(id)`, `title`→`name`, `url`→`https://jobs.smartrecruiters.com/{token}/{id}` (token + id URL-encoded), `location`→`location.fullLocation.trim()` or `location.city.trim()` or (`location.remote` ? "Remote" : "Unspecified"), `department`→`department.label` when present, `postedAt`→`releasedDate` when present. Missing `content` → `[]`.
- Seeded tokens must be live-verified (non-empty board) at seed time. `sources.json` stays committed config; existing 27 entries are preserved.

---

### Task 1: SmartRecruiters adapter

**Files:**
- Create: `src/adapters/smartrecruiters.ts`, `test/smartrecruiters.test.ts`
- Modify: `src/adapters/index.ts` (register the adapter)

**Interfaces:**
- Consumes: `CompanyAdapter, HttpClient, Job, CompanySource` from `../core/types.js`; `tokenOf` from `./util.js`.
- Produces: `export const smartRecruitersAdapter: CompanyAdapter` (`ats:"smartrecruiters"`), registered in `companyRegistry`.

- [ ] **Step 1: Write `test/smartrecruiters.test.ts` (RED)**

```ts
import { describe, it, expect } from "vitest";
import { smartRecruitersAdapter } from "../src/adapters/smartrecruiters.js";
import type { CompanySource, HttpClient } from "../src/core/types.js";

const source: CompanySource = { kind: "company", company: "ServiceNow", ats: "smartrecruiters", token: "ServiceNow", tier: 2 };

function fakeHttp(payload: unknown, capture?: (url: string) => void): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T> {
      capture?.(url);
      return payload as T;
    },
    async postJson<T>(): Promise<T> {
      throw new Error("postJson not used by SmartRecruiters");
    },
  };
}

describe("smartRecruitersAdapter", () => {
  it("hits the postings API with the token and limit=100", async () => {
    let seen = "";
    const http = fakeHttp({ content: [] }, (u) => (seen = u));
    await smartRecruitersAdapter.fetchJobs(source, http);
    expect(seen).toBe("https://api.smartrecruiters.com/v1/companies/ServiceNow/postings?limit=100");
  });

  it("normalizes id, title(name), constructed url, location, department, postedAt", async () => {
    const http = fakeHttp({
      content: [
        {
          id: "744000139827549",
          name: "Backend Engineer",
          releasedDate: "2026-06-24T10:00:11.853Z",
          location: { city: "Austin", region: "TX", country: "us", remote: false, fullLocation: "Austin, TX, United States" },
          department: { id: "868639", label: "Engineering" },
          company: { identifier: "ServiceNow", name: "ServiceNow" },
        },
      ],
    });
    const jobs = await smartRecruitersAdapter.fetchJobs(source, http);
    expect(jobs).toEqual([
      {
        id: "744000139827549",
        title: "Backend Engineer",
        url: "https://jobs.smartrecruiters.com/ServiceNow/744000139827549",
        location: "Austin, TX, United States",
        department: "Engineering",
        postedAt: "2026-06-24T10:00:11.853Z",
      },
    ]);
  });

  it("falls back to city then remote/unspecified for location", async () => {
    const http = fakeHttp({
      content: [
        { id: "a", name: "AI Engineer", location: { city: "  ", remote: true } },
        { id: "b", name: "Data Scientist", location: { city: "Berlin", remote: false } },
        { id: "c", name: "SRE", location: { remote: false } },
      ],
    });
    const jobs = await smartRecruitersAdapter.fetchJobs(source, http);
    expect(jobs[0]).toMatchObject({ id: "a", location: "Remote" });
    expect(jobs[1]).toMatchObject({ id: "b", location: "Berlin" });
    expect(jobs[2]).toMatchObject({ id: "c", location: "Unspecified" });
  });

  it("omits department and postedAt when absent", async () => {
    const http = fakeHttp({ content: [{ id: "x", name: "Backend Engineer", location: { fullLocation: "NYC" } }] });
    const jobs = await smartRecruitersAdapter.fetchJobs(source, http);
    expect(jobs[0]!.department).toBeUndefined();
    expect(jobs[0]!.postedAt).toBeUndefined();
    expect(jobs[0]).toMatchObject({ id: "x", title: "Backend Engineer", url: "https://jobs.smartrecruiters.com/ServiceNow/x", location: "NYC" });
  });

  it("URL-encodes the token in both the API and public URLs", async () => {
    let seen = "";
    const spaced: CompanySource = { kind: "company", company: "Foo Bar", ats: "smartrecruiters", token: "Foo Bar", tier: 2 };
    const http = fakeHttp({ content: [{ id: "1", name: "Engineer", location: { fullLocation: "NYC" } }] }, (u) => (seen = u));
    const jobs = await smartRecruitersAdapter.fetchJobs(spaced, http);
    expect(seen).toBe("https://api.smartrecruiters.com/v1/companies/Foo%20Bar/postings?limit=100");
    expect(jobs[0]!.url).toBe("https://jobs.smartrecruiters.com/Foo%20Bar/1");
  });

  it("tolerates a missing content array", async () => {
    const http = fakeHttp({});
    expect(await smartRecruitersAdapter.fetchJobs(source, http)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/smartrecruiters.test.ts`
Expected: FAIL — cannot find `../src/adapters/smartrecruiters.js`.

- [ ] **Step 3: Write `src/adapters/smartrecruiters.ts`**

```ts
import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";
import { tokenOf } from "./util.js";

// Fields we consume from the SmartRecruiters Posting API.
// Endpoint: GET https://api.smartrecruiters.com/v1/companies/{token}/postings?limit=100
interface SmartRecruitersPosting {
  id: string;
  name: string;
  releasedDate?: string | null;
  location?: {
    city?: string | null;
    fullLocation?: string | null;
    remote?: boolean | null;
  } | null;
  department?: { label?: string | null } | null;
}

interface SmartRecruitersResponse {
  content?: SmartRecruitersPosting[];
}

function normalize(raw: SmartRecruitersPosting, token: string): Job {
  const loc = raw.location;
  const location =
    loc?.fullLocation?.trim() || loc?.city?.trim() || (loc?.remote ? "Remote" : "Unspecified");
  const department = raw.department?.label ?? undefined;
  return {
    id: String(raw.id),
    title: raw.name,
    url: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${encodeURIComponent(raw.id)}`,
    location,
    ...(department ? { department } : {}),
    ...(raw.releasedDate ? { postedAt: raw.releasedDate } : {}),
  };
}

export const smartRecruitersAdapter: CompanyAdapter = {
  ats: "smartrecruiters",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    const token = tokenOf(source);
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100`;
    const data = await http.getJson<SmartRecruitersResponse>(url);
    return (data.content ?? []).map((raw) => normalize(raw, token));
  },
};
```

- [ ] **Step 4: Register in `src/adapters/index.ts`**

Add the import and the registry entry (keep greenhouse + ashby + lever):
```ts
import { smartRecruitersAdapter } from "./smartrecruiters.js";
```
```ts
const companyRegistry: Partial<Record<Ats, CompanyAdapter>> = {
  greenhouse: greenhouseAdapter,
  ashby: ashbyAdapter,
  lever: leverAdapter,
  smartrecruiters: smartRecruitersAdapter,
};
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `npx vitest run test/smartrecruiters.test.ts` → PASS (all).
Run: `npx vitest run` → full suite green.
Run: `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/smartrecruiters.ts test/smartrecruiters.test.ts src/adapters/index.ts
git commit -m "feat: add SmartRecruiters ATS adapter"
```

---

### Task 2: Seed many verified companies (Greenhouse + Ashby + SmartRecruiters)

**Files:**
- Modify: `sources.json`, `docs/deployment.md`

**Interfaces:**
- Consumes: the live Greenhouse/Ashby/SmartRecruiters APIs (public) to re-verify tokens.
- Produces: `sources.json` grows from 27 to ~66 entries; the existing 27 stay intact.

- [ ] **Step 1: Re-verify all candidate tokens live (keep only non-empty)**

Run this script. It prints the live job count for each candidate; ADD ONLY tokens with a positive count.
```bash
ghn () { curl -s "https://boards-api.greenhouse.io/v1/boards/$1/jobs" | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log((d.jobs||[]).length)}catch(e){console.log(0)}"; }
ashn () { curl -s "https://api.ashbyhq.com/posting-api/job-board/$1" | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log((d.jobs||[]).length)}catch(e){console.log(0)}"; }
srn () { curl -s "https://api.smartrecruiters.com/v1/companies/$1/postings?limit=1" | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(typeof d.totalFound==='number'?d.totalFound:0)}catch(e){console.log(0)}"; }

echo "# GREENHOUSE"; for t in airtable gitlab elastic datadog cloudflare mongodb okta twilio asana instacart affirm chime lyft flexport gemini betterment sofi roblox webflow vercel mercury faire waymo; do echo "$(ghn $t)  $t"; done
echo "# ASHBY"; for t in runway sierra harvey suno crusoe modal replit deepgram elevenlabs writer; do echo "$(ashn $t)  $t"; done
echo "# SMARTRECRUITERS"; for t in ServiceNow WesternDigital NielsenIQ Experian Visa WeWork; do echo "$(srn $t)  $t"; done
```
(Run the ATS groups separately if the combined loop is slow. A token that reports 0 or errors is dropped.)

- [ ] **Step 2: Append the verified entries to `sources.json`**

Keep the existing 27 entries (16 greenhouse + 8 ashby + 3 lever) intact and in order. Append the confirmed new ones, grouped by ATS. Tier guidance: AI-forward companies tier 1 (e.g. harvey, sierra, crusoe, elevenlabs, writer, deepgram, replit, modal, runway, waymo); the rest tier 2. Shapes:
```json
{ "kind": "company", "company": "Datadog", "ats": "greenhouse", "token": "datadog", "tier": 2 }
{ "kind": "company", "company": "Harvey", "ats": "ashby", "token": "harvey", "tier": 1 }
{ "kind": "company", "company": "ServiceNow", "ats": "smartrecruiters", "token": "ServiceNow", "tier": 2 }
```
Use display names with correct casing (`MongoDB`, `GitLab`, `SoFi`, `ElevenLabs`, `NielsenIQ`, `WeWork`, `ServiceNow`, `WesternDigital` → "Western Digital"). SmartRecruiters `token` MUST keep exact PascalCase (`ServiceNow`, `WesternDigital`, `NielsenIQ`) — it is case-sensitive. Add ONLY tokens confirmed non-empty in Step 1.

- [ ] **Step 3: Sanity-check the config loads and dispatches all four ATSes**

Run: `npx tsx -e "import('./src/config.ts').then(m => { const s = m.loadSources(); const ats = new Set(s.map(x => x.kind==='company' ? x.ats : x.kind)); console.log(s.length, [...ats].sort()); })"`
Expected: prints the new total (~66) and an array containing `ashby`, `greenhouse`, `lever`, `smartrecruiters`.

- [ ] **Step 4: Confirm no duplicate ats:token keys**

Run: `npx tsx -e "import('fs').then(fs => { const s = JSON.parse(fs.readFileSync('sources.json','utf8')); const keys = s.map(x => x.ats + ':' + (x.token||'')); const dupes = keys.filter((v,i,a)=>a.indexOf(v)!==i); console.log('dupes:', dupes.length ? dupes : 'none'); })"`
Expected: `dupes: none`.

- [ ] **Step 5: Add the SmartRecruiters bullet to the "Supported ATSes" list in `docs/deployment.md`**

```markdown
- **SmartRecruiters** — `"ats":"smartrecruiters"`, `token` = the case-sensitive company identifier (`api.smartrecruiters.com/v1/companies/{token}/postings`). Public, key-less; large enterprises (e.g. ServiceNow, Experian). Only the first 100 postings per company are fetched.
```

- [ ] **Step 6: Commit**

```bash
git add sources.json docs/deployment.md
git commit -m "feat: seed 39 more verified companies across Greenhouse, Ashby, SmartRecruiters"
```
(Adjust the count in the message to the actual number seeded.)

---

## Self-Review

**Spec coverage:**
- SmartRecruiters adapter mirroring the CompanyAdapter pattern, HttpClient-injected, tokenOf-based URL, constructed public job URL → Task 1. ✓
- normalize incl. name→title, fullLocation/city/remote fallback, department.label, releasedDate→postedAt, missing content → [] → Task 1 tests. ✓
- Token URL-encoded in both API and public URLs → Task 1 test. ✓
- Registered so `poll`/`supportedAtses` dispatch to it → Task 1 Step 4. ✓
- Seed verified companies across three ATSes, existing 27 preserved, no dup keys → Task 2. ✓
- No type/util changes (smartrecruiters already in Ats/SimpleSource union) → confirmed. ✓

**Placeholder scan:** none. Task 2's final list is determined by the Step-1 live re-verification.

**Type consistency:** `smartRecruitersAdapter: CompanyAdapter` with `ats:"smartrecruiters"`; `SmartRecruitersPosting`/`SmartRecruitersResponse` local; `normalize(raw, token): Job`. Uses `tokenOf`/registry exactly as the other adapters do.
