import { describe, it, expect } from "vitest";
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
