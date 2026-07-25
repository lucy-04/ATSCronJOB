import { describe, it, expect, afterEach, vi } from "vitest";
import { poll } from "../src/core/poll.js";
import { createSqliteStore } from "../src/core/state.js";
import { sourceLabel } from "../src/adapters/util.js";
import { queryRegistry } from "../src/adapters/index.js";
import type { HttpClient, Notification, Notifier, Source } from "../src/core/types.js";

// Returns a Greenhouse-shaped payload for any GET; postJson is never used here.
function fakeHttp(ids: number[]): HttpClient {
  return {
    async getJson<T>(): Promise<T> {
      return {
        jobs: ids.map((id) => ({
          id,
          title: `Job ${id}`,
          absolute_url: `https://x/${id}`,
          location: { name: "Remote" },
        })),
      } as T;
    },
    async postJson<T>(): Promise<T> {
      throw new Error("postJson not used in this test");
    },
  };
}

// Fake HTTP whose behavior depends on the Greenhouse board token in the URL:
// an array of ids returns that job list; "fail" throws.
function httpFor(behavior: Record<string, number[] | "fail">): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T> {
      const token = url.match(/\/boards\/([^/]+)\/jobs/)?.[1] ?? "";
      const b = behavior[token];
      if (b === undefined || b === "fail") throw new Error(`boom for ${token}`);
      return {
        jobs: b.map((id) => ({
          id,
          title: `Job ${id}`,
          absolute_url: `https://x/${id}`,
          location: { name: "Remote" },
        })),
      } as T;
    },
    async postJson<T>(): Promise<T> {
      throw new Error("postJson not used in this test");
    },
  };
}

function capturingNotifier(sink: Notification[]): Notifier {
  return {
    async notifyBatch(items: Notification[]): Promise<void> {
      sink.push(...items);
    },
  };
}

const source: Source = { kind: "company", company: "Acme", ats: "greenhouse", token: "acme", tier: 1 };

describe("poll", () => {
  afterEach(() => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
  });

  it("seeds silently on the first run, then notifies only new jobs", async () => {
    const store = createSqliteStore({ path: ":memory:" });

    const first: Notification[] = [];
    await poll({ sources: [source], http: fakeHttp([1]), store, notifier: capturingNotifier(first) });
    expect(first).toEqual([]); // seeded

    const second: Notification[] = [];
    await poll({ sources: [source], http: fakeHttp([1, 2]), store, notifier: capturingNotifier(second) });
    expect(second.map((n) => n.job.id)).toEqual(["2"]);
    expect(sourceLabel(second[0]!.source)).toBe("Acme");

    store.close();
  });

  it("skips sources whose ATS has no adapter", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const sink: Notification[] = [];
    const lever: Source = { kind: "company", company: "NoAdapter", ats: "lever", token: "x" };
    await poll({ sources: [lever], http: fakeHttp([1]), store, notifier: capturingNotifier(sink) });
    expect(sink).toEqual([]);
    store.close();
  });

  it("does not prune a source whose fetch failed this run", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    const a: Source = { kind: "company", company: "A", ats: "greenhouse", token: "a", tier: 1 };
    const b: Source = { kind: "company", company: "B", ats: "greenhouse", token: "b", tier: 1 };

    // Run 1 (T0): both boards healthy -> both seed silently.
    await poll({ sources: [a, b], http: httpFor({ a: [1], b: [1] }), store, notifier: { async notifyBatch() {} } });

    // Run 2 (T0+20d): board A is DOWN, B healthy. A's job (last_seen T0) is now
    // old enough to be prunable, but because A's fetch failed it must NOT be pruned.
    clock = Date.parse("2026-01-21T00:00:00Z");
    await poll({ sources: [a, b], http: httpFor({ a: "fail", b: [1] }), store, notifier: { async notifyBatch() {} } });

    // Run 3 (same clock): A recovers with the SAME job id. If A's row had been
    // pruned during its outage, job "1" would resurface as NEW here. It must not.
    const sink: Notification[] = [];
    await poll({ sources: [a, b], http: httpFor({ a: [1], b: [1] }), store, notifier: capturingNotifier(sink) });
    expect(sink).toEqual([]); // A's job survived the outage -> nothing new

    store.close();
  });

  it("logs a per-source summary line with the kind detail suffix", async () => {
    process.env.ADZUNA_APP_ID = "id1";
    process.env.ADZUNA_APP_KEY = "key1";
    const store = createSqliteStore({ path: ":memory:" });
    const company: Source = { kind: "company", company: "Acme", ats: "greenhouse", token: "acme", tier: 1 };
    const query: Source = {
      kind: "query",
      provider: "adzuna",
      query: "ML",
      where: "remote",
      country: "us",
      label: "ML remote",
      tier: 1,
    };
    const http: HttpClient = {
      async getJson<T>(url: string): Promise<T> {
        if (url.includes("/api/jobs/")) return { results: [] } as T;
        return { jobs: [] } as T;
      },
      async postJson<T>(): Promise<T> {
        throw new Error("unused");
      },
    };
    // Swap in a minimal fake for the query kind so this test only exercises
    // the summary-line path (not the real Adzuna network shape), then restore
    // the real registration afterward — other tests in this file depend on
    // the real adzuna adapter being registered (see adapters/index.ts).
    const originalAdzuna = queryRegistry.adzuna;
    queryRegistry.adzuna = { provider: "adzuna", async fetchJobs() { return []; } };
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await poll({ sources: [company, query], http, store, notifier: { async notifyBatch() {} } });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("Acme (greenhouse): 0 job(s), 0 new");
      expect(lines).toContain("ML remote (adzuna): 0 job(s), 0 new");
    } finally {
      spy.mockRestore();
      queryRegistry.adzuna = originalAdzuna;
      store.close();
    }
  });

  it("polls company and query sources together, deduping each independently", async () => {
    process.env.ADZUNA_APP_ID = "id1";
    process.env.ADZUNA_APP_KEY = "key1";
    const store = createSqliteStore({ path: ":memory:" });
    const company: Source = { kind: "company", company: "Acme", ats: "greenhouse", token: "acme", tier: 1 };
    const query: Source = { kind: "query", provider: "adzuna", query: "ML Engineer", where: "remote", country: "us", label: "ML remote", tier: 1 };

    const http: HttpClient = {
      async getJson<T>(url: string): Promise<T> {
        if (url.includes("/api/jobs/")) {
          return { results: [{ id: "a1", title: "ML Engineer", redirect_url: "https://x/a1", location: { display_name: "Remote" }, company: { display_name: "Startup Inc" } }] } as T;
        }
        return { jobs: [{ id: 1, title: "Backend", absolute_url: "https://x/1", location: { name: "NYC" } }] } as T;
      },
      async postJson<T>(): Promise<T> { throw new Error("unused"); },
    };

    // Run 1: both seed silently.
    const s1: Notification[] = [];
    await poll({ sources: [company, query], http, store, notifier: capturingNotifier(s1) });
    expect(s1).toEqual([]);

    // Run 2: query returns an extra job; company unchanged. Only the new query job notifies.
    const http2: HttpClient = {
      async getJson<T>(url: string): Promise<T> {
        if (url.includes("/api/jobs/")) {
          return { results: [
            { id: "a1", title: "ML Engineer", redirect_url: "https://x/a1", location: { display_name: "Remote" }, company: { display_name: "Startup Inc" } },
            { id: "a2", title: "Senior ML Engineer", redirect_url: "https://x/a2", location: { display_name: "Remote" }, company: { display_name: "BigCo" } },
          ] } as T;
        }
        return { jobs: [{ id: 1, title: "Backend", absolute_url: "https://x/1", location: { name: "NYC" } }] } as T;
      },
      async postJson<T>(): Promise<T> { throw new Error("unused"); },
    };
    const s2: Notification[] = [];
    await poll({ sources: [company, query], http: http2, store, notifier: capturingNotifier(s2) });
    expect(s2.map((n) => n.job.id)).toEqual(["a2"]);
    expect(s2[0]?.job.company).toBe("BigCo");

    store.close();
  });

  it("applies the role filter to company sources (only matching titles notify/record)", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const company: Source = { kind: "company", company: "Acme", ats: "greenhouse", token: "acme", tier: 1 };
    const roleFilter = { include: ["backend engineer"], exclude: ["senior"] };

    // Board returns a match, a senior (excluded), and an unrelated role.
    const jobsPayload = {
      jobs: [
        { id: 1, title: "Backend Engineer", absolute_url: "https://x/1", location: { name: "Remote" } },
        { id: 2, title: "Senior Backend Engineer", absolute_url: "https://x/2", location: { name: "Remote" } },
        { id: 3, title: "Sales Manager", absolute_url: "https://x/3", location: { name: "Remote" } },
      ],
    };
    const http: HttpClient = {
      async getJson<T>(): Promise<T> { return jobsPayload as T; },
      async postJson<T>(): Promise<T> { throw new Error("unused"); },
    };

    // Run 1 seeds silently. Run 2 (unchanged board) notifies nothing.
    const s1: Notification[] = [];
    await poll({ sources: [company], http, store, notifier: capturingNotifier(s1), roleFilter });
    expect(s1).toEqual([]);

    // Add a NEW matching job (id 4) plus a new non-matching one (id 5).
    const jobs2 = { jobs: [
      ...jobsPayload.jobs,
      { id: 4, title: "Full Stack Engineer", absolute_url: "https://x/4", location: { name: "Remote" } }, // not in include -> dropped
      { id: 5, title: "Backend Engineer, Platform", absolute_url: "https://x/5", location: { name: "Remote" } }, // matches
    ] };
    const http2: HttpClient = { async getJson<T>(): Promise<T> { return jobs2 as T; }, async postJson<T>(): Promise<T> { throw new Error("unused"); } };
    const s2: Notification[] = [];
    await poll({ sources: [company], http: http2, store, notifier: capturingNotifier(s2), roleFilter });
    expect(s2.map((n) => n.job.id)).toEqual(["5"]); // only the new *matching* job; id 4 filtered out, ids 1-3 already handled/filtered
    store.close();
  });

  it("query sources ignore the role filter and notify all new jobs", async () => {
    process.env.ADZUNA_APP_ID = "id1";
    process.env.ADZUNA_APP_KEY = "key1";
    const store = createSqliteStore({ path: ":memory:" });
    const query: Source = { kind: "query", provider: "adzuna", query: "anything", where: "remote", country: "us", label: "Q", tier: 1 };
    const roleFilter = { include: ["backend engineer"], exclude: [] };

    // Fake Adzuna adapter that returns jobs whose titles do NOT match the include filter.
    const fakeAdzunaAdapter = {
      provider: "adzuna" as const,
      async fetchJobs() {
        return [
          { id: "r1", title: "Recruiter", url: "https://x/r1", location: "Remote" },
        ];
      },
    };

    const originalAdzuna = queryRegistry.adzuna;
    queryRegistry.adzuna = fakeAdzunaAdapter;
    try {
      // Run 1: seed silently.
      const s1: Notification[] = [];
      await poll({ sources: [query], store, notifier: capturingNotifier(s1), roleFilter, http: {} as HttpClient });
      expect(s1).toEqual([]);

      // Run 2: add a NEW query job that does NOT match the include list.
      // It should still notify, proving query sources bypass the filter.
      const fakeAdzunaAdapter2 = {
        provider: "adzuna" as const,
        async fetchJobs() {
          return [
            { id: "r1", title: "Recruiter", url: "https://x/r1", location: "Remote" },
            { id: "sm1", title: "Sales Manager", url: "https://x/sm1", location: "Remote" }, // does NOT match include: ["backend engineer"]
          ];
        },
      };
      queryRegistry.adzuna = fakeAdzunaAdapter2;
      const s2: Notification[] = [];
      await poll({ sources: [query], store, notifier: capturingNotifier(s2), roleFilter, http: {} as HttpClient });
      // The new job notifies even though "Sales Manager" does not match the include list.
      expect(s2.map((n) => n.job.id)).toEqual(["sm1"]);
    } finally {
      queryRegistry.adzuna = originalAdzuna;
      store.close();
    }
  });
});
