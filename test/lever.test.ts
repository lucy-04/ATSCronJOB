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

  it("omits postedAt for an out-of-range epoch without throwing", async () => {
    // Beyond JS's ±8.64e15 ms date range: new Date(x).toISOString() would throw
    // RangeError; the adapter must degrade to no postedAt, not fail the board.
    const http = fakeHttp([
      { id: "big", text: "Backend Engineer", hostedUrl: "https://x/big", createdAt: 8.64e15 + 1, categories: {} },
    ]);
    const jobs = await leverAdapter.fetchJobs(source, http);
    expect(jobs[0]!.postedAt).toBeUndefined();
    expect(jobs[0]!.id).toBe("big");
  });

  it("tolerates a non-array response", async () => {
    const http = fakeHttp({ error: "nope" });
    expect(await leverAdapter.fetchJobs(source, http)).toEqual([]);
  });
});
