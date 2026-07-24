import { describe, it, expect } from "vitest";
import { poll } from "../src/core/poll.js";
import { createSqliteStore } from "../src/core/state.js";
import type { HttpClient, Notification, Notifier, Target } from "../src/core/types.js";

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

function capturingNotifier(sink: Notification[]): Notifier {
  return {
    async notifyBatch(items: Notification[]): Promise<void> {
      sink.push(...items);
    },
  };
}

const target: Target = { company: "Acme", ats: "greenhouse", token: "acme", tier: 1 };

describe("poll", () => {
  it("seeds silently on the first run, then notifies only new jobs", async () => {
    const store = createSqliteStore({ path: ":memory:" });

    const first: Notification[] = [];
    await poll({ targets: [target], http: fakeHttp([1]), store, notifier: capturingNotifier(first) });
    expect(first).toEqual([]); // seeded

    const second: Notification[] = [];
    await poll({ targets: [target], http: fakeHttp([1, 2]), store, notifier: capturingNotifier(second) });
    expect(second.map((n) => n.job.id)).toEqual(["2"]);
    expect(second[0]?.target.company).toBe("Acme");

    store.close();
  });

  it("skips targets whose ATS has no adapter", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    const sink: Notification[] = [];
    const lever: Target = { company: "NoAdapter", ats: "lever", token: "x" };
    await poll({ targets: [lever], http: fakeHttp([1]), store, notifier: capturingNotifier(sink) });
    expect(sink).toEqual([]);
    store.close();
  });
});
