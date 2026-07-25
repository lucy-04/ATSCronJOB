# Phase 7 — Lever Adapter + Seed Lever Companies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a Lever ATS adapter (the third ATS, after Greenhouse and Ashby) and seed the live Lever boards found by research (Palantir, Shield AI, Spotify), widening company coverage.

**Architecture:** Lever is a token/slug-based company ATS, so it slots into the existing `SimpleSource` (`ats:"lever"`, `token`) and `CompanyAdapter` pattern with zero type/util changes — a near-mirror of `src/adapters/ashby.ts`/`greenhouse.ts`. The role filter, dedup/prune engine, notifiers, config, and cron are reused untouched.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, vitest, tsx.

**Research (live, 2026-07-26):** Lever public postings API `GET https://api.lever.co/v0/postings/{token}?mode=json` returns a BARE JSON ARRAY of postings (not wrapped in an object). Each posting: `id` (uuid string), `text` (the title), `hostedUrl`, `applyUrl`, `createdAt` (epoch-ms NUMBER), `country`, `workplaceType` (e.g. "remote"|"hybrid"|"on-site"), `categories: { commitment, department, location, team, allLocations }`. Verified non-empty boards: palantir 287, shieldai 434, spotify 108. Many other well-known names 404 or are empty — Lever adoption has shrunk, so the seed is intentionally small.

## Global Constraints

- Node >= 20; ESM (`"type":"module"`) — relative imports use `.js` extensions; `import type` for type-only imports (`verbatimModuleSyntax`).
- No new dependencies.
- Tests under `test/`, run with `npx vitest run`; `npm run typecheck` stays clean (strict, `noUncheckedIndexedAccess`).
- The adapter is a `CompanyAdapter` with `ats:"lever"`; it uses the injected `HttpClient` (no direct fetch) and `tokenOf(source)` for the slug.
- `normalize()` maps: `id`→`String(id)` (dedup identity), `title`→`text`, `url`→`hostedUrl ?? applyUrl ?? ""`, `location`→`categories.location.trim()` or (`workplaceType === "remote"` ? "Remote" : "Unspecified"), `department`→`categories.department` when present, `postedAt`→`new Date(createdAt).toISOString()` when `createdAt` is a finite number. The response is a bare array; guard with `Array.isArray`.
- Seeded tokens must be live-verified (HTTP 200 with a non-empty array) at seed time. `sources.json` stays committed config.

---

### Task 1: Lever adapter

**Files:**
- Create: `src/adapters/lever.ts`, `test/lever.test.ts`
- Modify: `src/adapters/index.ts` (register the adapter)

**Interfaces:**
- Consumes: `CompanyAdapter, HttpClient, Job, CompanySource` from `../core/types.js`; `tokenOf` from `./util.js`.
- Produces: `export const leverAdapter: CompanyAdapter` (`ats:"lever"`), registered in `companyRegistry`.

- [ ] **Step 1: Write `test/lever.test.ts` (RED)**

```ts
import { describe, it, expect } from "vitest";
import { leverAdapter } from "../src/adapters/lever.js";
import type { CompanySource, HttpClient } from "../src/core/types.js";

const source: CompanySource = { kind: "company", company: "Palantir", ats: "lever", token: "palantir", tier: 1 };

// Fake HTTP returning a recorded Lever-shaped array; postJson is unused.
function fakeHttp(payload: unknown, capture?: (url: string) => void): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T> {
      capture?.(url);
      return payload as T;
    },
    async postJson<T>(): Promise<T> {
      throw new Error("postJson not used by Lever");
    },
  };
}

describe("leverAdapter", () => {
  it("hits the postings API with the token and mode=json", async () => {
    let seen = "";
    const http = fakeHttp([], (u) => (seen = u));
    await leverAdapter.fetchJobs(source, http);
    expect(seen).toBe("https://api.lever.co/v0/postings/palantir?mode=json");
  });

  it("normalizes id, title(text), url, location, department, postedAt", async () => {
    const http = fakeHttp([
      {
        id: "890b2c0f",
        text: "Backend Engineer",
        hostedUrl: "https://jobs.lever.co/palantir/890b2c0f",
        applyUrl: "https://jobs.lever.co/palantir/890b2c0f/apply",
        createdAt: 1784569799619,
        workplaceType: "hybrid",
        categories: { department: "Engineering", location: "London", team: "Platform" },
      },
    ]);
    const jobs = await leverAdapter.fetchJobs(source, http);
    expect(jobs).toEqual([
      {
        id: "890b2c0f",
        title: "Backend Engineer",
        url: "https://jobs.lever.co/palantir/890b2c0f",
        location: "London",
        department: "Engineering",
        postedAt: new Date(1784569799619).toISOString(),
      },
    ]);
  });

  it("falls back to applyUrl, and marks remote/unspecified location from workplaceType", async () => {
    const http = fakeHttp([
      { id: "r1", text: "AI Engineer", applyUrl: "https://jobs.lever.co/palantir/r1/apply", workplaceType: "remote", categories: {} },
      { id: "u1", text: "Data Scientist", hostedUrl: "https://jobs.lever.co/palantir/u1", workplaceType: "on-site", categories: { location: "   " } },
    ]);
    const jobs = await leverAdapter.fetchJobs(source, http);
    expect(jobs[0]).toMatchObject({ id: "r1", url: "https://jobs.lever.co/palantir/r1/apply", location: "Remote" });
    expect(jobs[1]).toMatchObject({ id: "u1", location: "Unspecified" });
  });

  it("omits postedAt when createdAt is missing or not a number", async () => {
    const http = fakeHttp([
      { id: "a", text: "Backend Engineer", hostedUrl: "https://x/a", categories: {} },
      { id: "b", text: "Backend Engineer", hostedUrl: "https://x/b", createdAt: "nope", categories: {} },
    ]);
    const jobs = await leverAdapter.fetchJobs(source, http);
    expect(jobs[0]!.postedAt).toBeUndefined();
    expect(jobs[1]!.postedAt).toBeUndefined();
  });

  it("tolerates a non-array response", async () => {
    const http = fakeHttp({ error: "nope" });
    expect(await leverAdapter.fetchJobs(source, http)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/lever.test.ts`
Expected: FAIL — cannot find `../src/adapters/lever.js`.

- [ ] **Step 3: Write `src/adapters/lever.ts`**

```ts
import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";
import { tokenOf } from "./util.js";

// Fields we consume from the Lever postings API.
// Endpoint: GET https://api.lever.co/v0/postings/{token}?mode=json  (bare array)
interface LeverJob {
  id: string;
  text: string;
  hostedUrl?: string | null;
  applyUrl?: string | null;
  createdAt?: number | null;
  workplaceType?: string | null;
  categories?: {
    department?: string | null;
    location?: string | null;
  } | null;
}

function normalize(raw: LeverJob): Job {
  const loc = raw.categories?.location?.trim();
  const location = loc || (raw.workplaceType === "remote" ? "Remote" : "Unspecified");
  const department = raw.categories?.department ?? undefined;
  const postedAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? new Date(raw.createdAt).toISOString()
      : undefined;
  return {
    id: String(raw.id),
    title: raw.text,
    url: raw.hostedUrl ?? raw.applyUrl ?? "",
    location,
    ...(department ? { department } : {}),
    ...(postedAt ? { postedAt } : {}),
  };
}

export const leverAdapter: CompanyAdapter = {
  ats: "lever",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(tokenOf(source))}?mode=json`;
    const data = await http.getJson<unknown>(url);
    return (Array.isArray(data) ? (data as LeverJob[]) : []).map(normalize);
  },
};
```

- [ ] **Step 4: Register in `src/adapters/index.ts`**

Add the import and the registry entry (keep greenhouse + ashby):
```ts
import { leverAdapter } from "./lever.js";
```
```ts
const companyRegistry: Partial<Record<Ats, CompanyAdapter>> = {
  greenhouse: greenhouseAdapter,
  ashby: ashbyAdapter,
  lever: leverAdapter,
};
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `npx vitest run test/lever.test.ts` → PASS (all).
Run: `npx vitest run` → full suite green.
Run: `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/lever.ts test/lever.test.ts src/adapters/index.ts
git commit -m "feat: add Lever ATS adapter"
```

---

### Task 2: Seed Lever companies into sources.json

**Files:**
- Modify: `sources.json`, `docs/deployment.md`

**Interfaces:**
- Consumes: the live Lever postings API (public) to verify tokens; the existing 24 entries stay.
- Produces: `sources.json` gains verified `ats:"lever"` company entries.

- [ ] **Step 1: Verify candidate Lever tokens live**

Run (public API, no auth) — keep only tokens whose array is NON-EMPTY:
```bash
for t in palantir shieldai spotify; do
  n=$(curl -s "https://api.lever.co/v0/postings/$t?mode=json" | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(Array.isArray(d)?d.length:0)}catch(e){console.log('ERR')}")
  echo "$n  $t"
done
```
Record which returned a positive count. Only those get added. (If you want to try additional Lever slugs, verify each the same way; add only confirmed non-empty ones.)

- [ ] **Step 2: Append verified Lever entries to `sources.json`**

Keep the existing 24 entries (16 Greenhouse + 8 Ashby) intact and in order. Append the confirmed Lever ones. Tier 1 for AI-forward companies (palantir, shieldai), tier 2 otherwise (spotify). Shape per entry:
```json
{ "kind": "company", "company": "Palantir", "ats": "lever", "token": "palantir", "tier": 1 }
```
Add ONLY tokens confirmed non-empty in Step 1.

- [ ] **Step 3: Sanity-check the config loads and dispatches all three ATSes**

Run: `npx tsx -e "import('./src/config.ts').then(m => { const s = m.loadSources(); const ats = new Set(s.map(x => x.kind==='company' ? x.ats : x.kind)); console.log(s.length, [...ats].sort()); })"`
Expected: prints the new total count and an array containing `ashby`, `greenhouse`, and `lever`.

- [ ] **Step 4: Update the "Supported ATSes" list in `docs/deployment.md`**

Add a Lever bullet under the existing Greenhouse/Ashby list:
```markdown
- **Lever** — `"ats":"lever"`, `token` = postings slug (`api.lever.co/v0/postings/{token}?mode=json`). Public, key-less; returns a bare array of postings.
```

- [ ] **Step 5: Commit**

```bash
git add sources.json docs/deployment.md
git commit -m "feat: seed sources.json with verified Lever companies"
```

---

## Self-Review

**Spec coverage:**
- Lever adapter mirroring the CompanyAdapter pattern, HttpClient-injected, tokenOf-based URL → Task 1. ✓
- normalize incl. text→title, hostedUrl/applyUrl fallback, categories.location/department, workplaceType remote fallback, createdAt(number)→ISO, non-array tolerance → Task 1 tests. ✓
- Registered so `poll`/`supportedAtses` dispatch to it → Task 1 Step 4. ✓
- Seed verified Lever companies, existing 24 entries preserved → Task 2. ✓
- No type/util changes needed (lever already in Ats + SimpleSource union) → confirmed. ✓

**Placeholder scan:** none. Task 2's list is determined by the Step-1 live check.

**Type consistency:** `leverAdapter: CompanyAdapter` with `ats:"lever"`; `LeverJob` local; `normalize(raw): Job`. Uses `tokenOf`/registry exactly as ashby/greenhouse do.
