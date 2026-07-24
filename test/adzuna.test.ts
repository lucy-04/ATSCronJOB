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
