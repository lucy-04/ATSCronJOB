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
