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
