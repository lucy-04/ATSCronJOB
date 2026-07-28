# Phase 10 — SmartRecruiters `country` filter + India enterprise seed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a SmartRecruiters company source be scoped to one country via the SR API's `&country=` param, and seed India-heavy enterprises (BoschGroup, Continental) filtered to India — reaching India roles from global enterprises that the India-HQ slug companies can't cover.

**Architecture:** SmartRecruiters is already a `SimpleSource`. Add an optional `country?` to `SimpleSource`; the SR adapter appends `&country={country}` when set; `sourceKeyOf` incorporates the country so a country-scoped source is a DISTINCT dedup identity from the same company's global source. Everything else (role filter, dedup/prune, notifiers, other adapters) is unchanged. Only the SmartRecruiters adapter reads `country`; other ATSes ignore it.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, vitest, tsx.

**Research (live 2026-07-28):** SR API `...?limit=100&country=in` filters server-side. India counts: BoschGroup 546, Continental 101; existing entries also have India roles (Experian 69, NielsenIQ 55, ServiceNow 24) but stay global this round.

## Global Constraints

- Node >= 20; ESM (`verbatimModuleSyntax`): `.js` relative imports, `import type` for types. No new dependencies.
- Tests under `test/`, `npx vitest run`; `npm run typecheck` clean (strict, `noUncheckedIndexedAccess`).
- **Backward compatibility is critical:** a source WITHOUT `country` must produce the EXACT same `sourceKeyOf` and the EXACT same SR URL (`?limit=100`) as today — otherwise existing dedup histories reset and existing tests break. Only sources WITH `country` change behavior.
- `country` is only meaningful for SmartRecruiters; the type allows it on any `SimpleSource` but only the SR adapter and `sourceKeyOf` read it.

---

### Task 1: `country` support in type, adapter, and dedup key

**Files:**
- Modify: `src/core/types.ts`, `src/adapters/smartrecruiters.ts`, `src/adapters/util.ts`
- Modify (tests): `test/smartrecruiters.test.ts`, `test/util.test.ts`

**Interfaces:**
- Consumes: existing `SimpleSource`, `tokenOf`, `sourceKeyOf`.
- Produces: `SimpleSource.country?: string`; SR adapter URL gains `&country=` when set; `sourceKeyOf` appends `:{country}` (lowercased) when set.

- [ ] **Step 1: Add `country?` to `SimpleSource` in `src/core/types.ts`**

In the `SimpleSource` interface (the token-based ATS source), add:
```ts
  /**
   * Optional ISO country code to scope the board to one country. Currently only
   * SmartRecruiters honours it (its API supports `&country=in`); other adapters
   * ignore it. A country-scoped source is a distinct dedup identity (see sourceKeyOf).
   */
  country?: string;
```

- [ ] **Step 2: Write the failing tests (RED)**

In `test/smartrecruiters.test.ts`, add inside the describe block:
```ts
  it("adds &country= when the source has a country", async () => {
    let seen = "";
    const inSource: CompanySource = { kind: "company", company: "BoschGroup", ats: "smartrecruiters", token: "BoschGroup", country: "in", tier: 2 };
    const http = fakeHttp({ content: [] }, (u) => (seen = u));
    await smartRecruitersAdapter.fetchJobs(inSource, http);
    expect(seen).toBe("https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=100&country=in");
  });

  it("omits country from the URL when the source has none (unchanged)", async () => {
    let seen = "";
    const http = fakeHttp({ content: [] }, (u) => (seen = u));
    await smartRecruitersAdapter.fetchJobs(source, http); // `source` = ServiceNow, no country
    expect(seen).toBe("https://api.smartrecruiters.com/v1/companies/ServiceNow/postings?limit=100");
  });
```
In `test/util.test.ts`, add inside the `sourceKeyOf` describe:
```ts
  it("keeps the company key unchanged when there is no country", () => {
    const s: Source = { kind: "company", company: "Bosch", ats: "smartrecruiters", token: "BoschGroup" };
    expect(sourceKeyOf(s)).toBe("smartrecruiters:BoschGroup");
  });
  it("makes a country-scoped source a distinct key (lowercased)", () => {
    const global: Source = { kind: "company", company: "Bosch", ats: "smartrecruiters", token: "BoschGroup" };
    const india: Source = { kind: "company", company: "Bosch", ats: "smartrecruiters", token: "BoschGroup", country: "IN" };
    expect(sourceKeyOf(india)).toBe("smartrecruiters:BoschGroup:in");
    expect(sourceKeyOf(india)).not.toBe(sourceKeyOf(global));
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/smartrecruiters.test.ts test/util.test.ts`
Expected: the new cases FAIL (country not yet in URL/key).

- [ ] **Step 4: Implement — SR adapter (`src/adapters/smartrecruiters.ts`)**

Replace the URL-building in `fetchJobs`:
```ts
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    const token = tokenOf(source);
    const country = "country" in source ? source.country : undefined;
    const params = new URLSearchParams({ limit: "100" });
    if (country) params.set("country", country);
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?${params.toString()}`;
    const data = await http.getJson<SmartRecruitersResponse>(url);
    return (data.content ?? []).map((raw) => normalize(raw, token));
  },
```

- [ ] **Step 5: Implement — `sourceKeyOf` (`src/adapters/util.ts`)**

Replace the final `return` (the non-workday token branch):
```ts
  const key = `${source.ats}:${source.token}`;
  return source.country ? `${key}:${source.country.toLowerCase()}` : key;
```
(The `source.kind === "query"` and `source.ats === "workday"` branches above are unchanged. After them, `source` is the non-workday `SimpleSource`, so `source.country` is valid.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/smartrecruiters.test.ts test/util.test.ts` → PASS.
Run: `npx vitest run` → full suite green (existing no-country tests still pass, proving back-compat).
Run: `npm run typecheck` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/adapters/smartrecruiters.ts src/adapters/util.ts test/smartrecruiters.test.ts test/util.test.ts
git commit -m "feat: SmartRecruiters country filter (distinct dedup key per country)"
```

---

### Task 2: Seed India SmartRecruiters enterprises + docs

**Files:**
- Modify: `sources.json`, `docs/deployment.md`

- [ ] **Step 1: Re-verify India counts live (keep only non-empty)**

```bash
srin () { curl -s "https://api.smartrecruiters.com/v1/companies/$1/postings?limit=1&country=in" | node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(typeof d.totalFound==='number'?d.totalFound:0)}catch(e){console.log(0)}"; }
for c in BoschGroup Continental; do echo "$(srin $c)  $c"; done
```
Expect BoschGroup ~546, Continental ~101. Add only non-empty.

- [ ] **Step 2: Append to `sources.json`** (after the existing 103 entries, preserving order):
```json
  { "kind": "company", "company": "Bosch India", "ats": "smartrecruiters", "token": "BoschGroup", "country": "in", "tier": 2 },
  { "kind": "company", "company": "Continental India", "ats": "smartrecruiters", "token": "Continental", "country": "in", "tier": 2 }
```
Token stays exact PascalCase. These are NEW tokens (no collision with existing SR entries).

- [ ] **Step 3: Verify structure**

Run: `npx tsx -e "import('./src/config.ts').then(m => { const s = m.loadSources(); console.log(s.length); })"` → 105.
Run the dup-key check (note: keys now include country, so include it):
```bash
npx tsx -e "import('fs').then(fs => { const s = JSON.parse(fs.readFileSync('sources.json','utf8')); const k = s.map(x => x.ats+':'+(x.token||'')+':'+(x.country||'')); const d = k.filter((v,i,a)=>a.indexOf(v)!==i); console.log('dupes:', d.length?d:'none'); })"
```
Expect `dupes: none`.

- [ ] **Step 4: Doc note in `docs/deployment.md`** — extend the SmartRecruiters bullet:
```markdown
  Add `"country": "in"` (ISO code) to a SmartRecruiters source to scope it to one country server-side (e.g. Bosch India). A country-scoped source dedups independently from the same company's global source.
```

- [ ] **Step 5: Commit**

```bash
git add sources.json docs/deployment.md
git commit -m "feat: seed India-scoped SmartRecruiters enterprises (Bosch, Continental)"
```

---

## Self-Review

- Back-compat: no-country sources keep identical key + URL → existing tests/dedup unaffected (Task 1 Steps 4–5 guard both; the "omits country" and "unchanged key" tests prove it). ✓
- country flows: type → adapter URL → dedup key, all three, with a distinct key so global vs India of the same company never collide. ✓
- Seed uses new tokens (Bosch/Continental) so no key collision; India counts live-verified. ✓
- Only SR reads country; other adapters/tests untouched. ✓
