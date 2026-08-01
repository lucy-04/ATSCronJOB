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

  it("keeps paginating when Workday reports total only on page 1 (later pages total=0)", async () => {
    // Real Workday quirk: total is present on the first page and 0 on every later
    // page, even though results keep coming. The adapter must not stop at page 2.
    const calls: { url: string; body: any }[] = [];
    const http = pagedHttp({
      // total (100) is only on page 1; later pages report 0 but still serve jobs.
      0: { total: 100, jobPostings: Array.from({ length: 20 }, (_, i) => wdJob("P0-" + i, "/job/India-Pune/P0-" + i, "India, Pune")) },
      20: { total: 0, jobPostings: Array.from({ length: 20 }, (_, i) => wdJob("P1-" + i, "/job/India-Pune/P1-" + i, "2 Locations")) },
      40: { total: 0, jobPostings: Array.from({ length: 5 }, (_, i) => wdJob("P2-" + i, "/job/India-Pune/P2-" + i, "India, Bengaluru")) },
      // offset 60 is unmapped -> pagedHttp returns an empty page -> loop stops
    }, calls);
    const jobs = await workdayAdapter.fetchJobs(source, http);
    expect(jobs).toHaveLength(45); // 20 + 20 + 5, NOT capped at 40 by a later page's total=0
    expect(calls.map((c) => c.body.offset)).toEqual([0, 20, 40, 60]);
  });

  it("dedupes by id when a posting repeats across pages (no double-notify)", async () => {
    const calls: { url: string; body: any }[] = [];
    const http = pagedHttp({
      0: { total: 100, jobPostings: [wdJob("JR1", "/job/India-Pune/JR1", "India, Pune"), wdJob("JR2", "/job/India-Pune/JR2", "India, Pune")] },
      // offset 20 repeats JR2 (pagination against a shifting list) + a new JR3
      20: { total: 0, jobPostings: [wdJob("JR2", "/job/India-Pune/JR2", "India, Pune"), wdJob("JR3", "/job/India-Pune/JR3", "India, Pune")] },
    }, calls);
    const jobs = await workdayAdapter.fetchJobs(source, http);
    expect(jobs.map((j) => j.id).sort()).toEqual(["JR1", "JR2", "JR3"]); // JR2 appears once, not twice
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
