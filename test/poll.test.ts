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
    // Adzuna's real adapter isn't registered on this branch yet (that's a
    // separate task); register a minimal fake for the query kind so this test
    // can exercise the query-source summary-line path end to end via poll().
    queryRegistry.adzuna = { provider: "adzuna", async fetchJobs() { return []; } };
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await poll({ sources: [company, query], http, store, notifier: { async notifyBatch() {} } });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("Acme (greenhouse): 0 job(s), 0 new");
      expect(lines).toContain("ML remote (adzuna): 0 job(s), 0 new");
    } finally {
      spy.mockRestore();
      delete queryRegistry.adzuna;
      store.close();
    }
  });
});
