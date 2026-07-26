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
