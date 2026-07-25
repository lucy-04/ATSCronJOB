import { describe, it, expect } from "vitest";
import { ashbyAdapter } from "../src/adapters/ashby.js";
import type { CompanySource, HttpClient } from "../src/core/types.js";

const source: CompanySource = { kind: "company", company: "OpenAI", ats: "ashby", token: "openai", tier: 1 };

// Fake HTTP returning a recorded Ashby-shaped payload; postJson is unused.
function fakeHttp(payload: unknown, capture?: (url: string) => void): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T> {
      capture?.(url);
      return payload as T;
    },
    async postJson<T>(): Promise<T> {
      throw new Error("postJson not used by Ashby");
    },
  };
}

describe("ashbyAdapter", () => {
  it("hits the job-board posting API with the token", async () => {
    let seen = "";
    const http = fakeHttp({ jobs: [] }, (u) => (seen = u));
    await ashbyAdapter.fetchJobs(source, http);
    expect(seen).toBe("https://api.ashbyhq.com/posting-api/job-board/openai");
  });

  it("normalizes id, title, url, location, department, postedAt", async () => {
    const http = fakeHttp({
      jobs: [
        {
          id: "abc-123",
          title: "Backend Engineer",
          location: "San Francisco",
          department: "Engineering",
          jobUrl: "https://jobs.ashbyhq.com/openai/abc-123",
          applyUrl: "https://jobs.ashbyhq.com/openai/abc-123/application",
          isRemote: null,
          isListed: true,
          publishedAt: "2026-03-12T16:38:15.322+00:00",
        },
      ],
    });
    const jobs = await ashbyAdapter.fetchJobs(source, http);
    expect(jobs).toEqual([
      {
        id: "abc-123",
        title: "Backend Engineer",
        url: "https://jobs.ashbyhq.com/openai/abc-123",
        location: "San Francisco",
        department: "Engineering",
        postedAt: "2026-03-12T16:38:15.322+00:00",
      },
    ]);
  });

  it("falls back to applyUrl when jobUrl is absent, and marks remote/unspecified location", async () => {
    const http = fakeHttp({
      jobs: [
        { id: "r1", title: "AI Engineer", location: null, isRemote: true, isListed: true, applyUrl: "https://jobs.ashbyhq.com/openai/r1/application" },
        { id: "u1", title: "Data Scientist", location: "  ", isRemote: null, isListed: true, jobUrl: "https://jobs.ashbyhq.com/openai/u1" },
      ],
    });
    const jobs = await ashbyAdapter.fetchJobs(source, http);
    expect(jobs[0]).toMatchObject({ id: "r1", url: "https://jobs.ashbyhq.com/openai/r1/application", location: "Remote" });
    expect(jobs[1]).toMatchObject({ id: "u1", location: "Unspecified" });
  });

  it("skips unlisted jobs (isListed === false)", async () => {
    const http = fakeHttp({
      jobs: [
        { id: "keep", title: "Backend Engineer", location: "NYC", isListed: true, jobUrl: "https://x/keep" },
        { id: "drop", title: "Hidden Role", location: "NYC", isListed: false, jobUrl: "https://x/drop" },
      ],
    });
    const jobs = await ashbyAdapter.fetchJobs(source, http);
    expect(jobs.map((j) => j.id)).toEqual(["keep"]);
  });

  it("tolerates a missing jobs array", async () => {
    const http = fakeHttp({});
    expect(await ashbyAdapter.fetchJobs(source, http)).toEqual([]);
  });
});
