import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../src/core/state.js";
import type { Job } from "../src/core/types.js";

function job(id: string): Job {
  return { id, title: `Job ${id}`, url: `https://x/${id}`, location: "Remote" };
}

describe("diffAndRecord", () => {
  it("seeds silently on a source's first run", () => {
    const store = createSqliteStore({ path: ":memory:" });
    expect(store.diffAndRecord("gh:acme", [job("1"), job("2")])).toEqual([]);
    store.close();
  });

  it("detects a newly-added job on a later run", () => {
    const store = createSqliteStore({ path: ":memory:" });
    store.diffAndRecord("gh:acme", [job("1"), job("2")]);
    const found = store.diffAndRecord("gh:acme", [job("1"), job("2"), job("3")]);
    expect(found.map((j) => j.id)).toEqual(["3"]);
    store.close();
  });

  it("returns nothing when the board is unchanged", () => {
    const store = createSqliteStore({ path: ":memory:" });
    store.diffAndRecord("gh:acme", [job("1")]);
    expect(store.diffAndRecord("gh:acme", [job("1")])).toEqual([]);
    store.close();
  });

  it("tracks each source independently", () => {
    const store = createSqliteStore({ path: ":memory:" });
    store.diffAndRecord("gh:acme", [job("1")]);          // acme seeded
    const found = store.diffAndRecord("gh:other", [job("1")]); // other's first run
    expect(found).toEqual([]);                            // seeded, not "already seen"
    store.close();
  });
});

describe("prune", () => {
  it("removes jobs not seen within graceDays", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:acme", [job("1")]); // last_seen = Jan 1
    clock = Date.parse("2026-01-21T00:00:00Z");  // +20 days, job absent from board
    expect(store.prune(14, ["gh:acme"])).toBe(1);
    store.close();
  });

  it("keeps jobs still within graceDays", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:acme", [job("1")]);
    clock = Date.parse("2026-01-10T00:00:00Z"); // +9 days
    expect(store.prune(14, ["gh:acme"])).toBe(0);
    store.close();
  });

  it("re-notifies a job that reappears after being pruned", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:acme", [job("1")]); // seeded silently
    clock = Date.parse("2026-01-21T00:00:00Z");
    store.prune(14, ["gh:acme"]);                // job 1 aged out
    const found = store.diffAndRecord("gh:acme", [job("1")]); // reappears
    expect(found.map((j) => j.id)).toEqual(["1"]); // source known -> counts as new
    store.close();
  });

  it("keeps first_seen stable and advances last_seen across runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ats-state-test-"));
    const dbPath = join(dir, "state.db");
    const T0 = Date.parse("2026-01-01T00:00:00Z");
    const T1 = Date.parse("2026-01-05T00:00:00Z");
    let clock = T0;

    try {
      const store = createSqliteStore({ path: dbPath, now: () => clock });
      expect(store.diffAndRecord("gh:acme", [job("1")])).toEqual([]); // seeded at T0
      clock = T1;
      expect(store.diffAndRecord("gh:acme", [job("1")])).toEqual([]); // unchanged board at T1
      store.close();

      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(`SELECT first_seen, last_seen FROM seen_jobs WHERE source = ? AND job_id = ?`)
        .get("gh:acme", "1") as { first_seen: string; last_seen: string };
      db.close();

      expect(row.first_seen).toBe(new Date(T0).toISOString()); // stable, not overwritten
      expect(row.last_seen).toBe(new Date(T1).toISOString());   // advanced
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes nothing when the sources list is empty", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:acme", [job("1")]);
    clock = Date.parse("2026-01-21T00:00:00Z"); // +20d, would be stale
    expect(store.prune(14, [])).toBe(0);
    // proof it was prunable: pruning WITH the source now removes it
    expect(store.prune(14, ["gh:acme"])).toBe(1);
    store.close();
  });

  it("only prunes the sources it is given", () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    store.diffAndRecord("gh:a", [job("1")]);
    store.diffAndRecord("gh:b", [job("1")]);
    clock = Date.parse("2026-01-21T00:00:00Z"); // +20d, both stale
    expect(store.prune(14, ["gh:a"])).toBe(1); // only gh:a
    expect(store.prune(14, ["gh:b"])).toBe(1); // gh:b still there until named
    store.close();
  });
});
