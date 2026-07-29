import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../src/core/state.js";
import type { Job } from "../src/core/types.js";

function job(id: string): Job {
  return { id, title: `Job ${id}`, url: `https://x/${id}`, location: "Remote" };
}

describe("diffAndRecord", () => {
  it("seeds silently on a source's first run", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    expect(await store.diffAndRecord("gh:acme", [job("1"), job("2")])).toEqual([]);
    await store.close();
  });

  it("detects a newly-added job on a later run", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    await store.diffAndRecord("gh:acme", [job("1"), job("2")]);
    const found = await store.diffAndRecord("gh:acme", [job("1"), job("2"), job("3")]);
    expect(found.map((j) => j.id)).toEqual(["3"]);
    await store.close();
  });

  it("returns nothing when the board is unchanged", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    await store.diffAndRecord("gh:acme", [job("1")]);
    expect(await store.diffAndRecord("gh:acme", [job("1")])).toEqual([]);
    await store.close();
  });

  it("tracks each source independently", async () => {
    const store = createSqliteStore({ path: ":memory:" });
    await store.diffAndRecord("gh:acme", [job("1")]);          // acme seeded
    const found = await store.diffAndRecord("gh:other", [job("1")]); // other's first run
    expect(found).toEqual([]);                            // seeded, not "already seen"
    await store.close();
  });
});

describe("prune", () => {
  it("removes jobs not seen within graceDays", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    await store.diffAndRecord("gh:acme", [job("1")]); // last_seen = Jan 1
    clock = Date.parse("2026-01-21T00:00:00Z");  // +20 days, job absent from board
    expect(await store.prune(14, ["gh:acme"])).toBe(1);
    await store.close();
  });

  it("keeps jobs still within graceDays", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    await store.diffAndRecord("gh:acme", [job("1")]);
    clock = Date.parse("2026-01-10T00:00:00Z"); // +9 days
    expect(await store.prune(14, ["gh:acme"])).toBe(0);
    await store.close();
  });

  it("re-notifies a job that reappears after being pruned", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    await store.diffAndRecord("gh:acme", [job("1")]); // seeded silently
    clock = Date.parse("2026-01-21T00:00:00Z");
    await store.prune(14, ["gh:acme"]);                // job 1 aged out
    const found = await store.diffAndRecord("gh:acme", [job("1")]); // reappears
    expect(found.map((j) => j.id)).toEqual(["1"]); // source known -> counts as new
    await store.close();
  });

  it("keeps first_seen stable and advances last_seen across runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ats-state-test-"));
    const dbPath = join(dir, "state.db");
    const T0 = Date.parse("2026-01-01T00:00:00Z");
    const T1 = Date.parse("2026-01-05T00:00:00Z");
    let clock = T0;

    try {
      const store = createSqliteStore({ path: dbPath, now: () => clock });
      expect(await store.diffAndRecord("gh:acme", [job("1")])).toEqual([]); // seeded at T0
      clock = T1;
      expect(await store.diffAndRecord("gh:acme", [job("1")])).toEqual([]); // unchanged board at T1
      await store.close();

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

  it("prunes nothing when the sources list is empty", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    await store.diffAndRecord("gh:acme", [job("1")]);
    clock = Date.parse("2026-01-21T00:00:00Z"); // +20d, would be stale
    expect(await store.prune(14, [])).toBe(0);
    // proof it was prunable: pruning WITH the source now removes it
    expect(await store.prune(14, ["gh:acme"])).toBe(1);
    await store.close();
  });

  it("only prunes the sources it is given", async () => {
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = createSqliteStore({ path: ":memory:", now: () => clock });
    await store.diffAndRecord("gh:a", [job("1")]);
    await store.diffAndRecord("gh:b", [job("1")]);
    clock = Date.parse("2026-01-21T00:00:00Z"); // +20d, both stale
    expect(await store.prune(14, ["gh:a"])).toBe(1); // only gh:a
    expect(await store.prune(14, ["gh:b"])).toBe(1); // gh:b still there until named
    await store.close();
  });
});

describe("close (WAL checkpoint)", () => {
  it("folds WAL writes into the main db file and truncates the -wal file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-wal-"));
    const dbPath = join(dir, "state.db");
    // A second, idle connection to the SAME on-disk file, kept open across
    // store.close(). This is the crux of the test: SQLite auto-truncates the
    // -wal file when the LAST connection closes, regardless of any explicit
    // checkpoint pragma. With this second connection still open, store.close()
    // is no longer closing the last connection — so only the store's own
    // `wal_checkpoint(TRUNCATE)` can zero out the -wal file. Without that
    // pragma, this test genuinely fails.
    const idleConn = new Database(dbPath);
    try {
      const store = createSqliteStore({ path: dbPath });
      await store.diffAndRecord("gh:acme", [job("1")]);

      // A merely-*opened* second connection doesn't register as a WAL reader
      // until it actually touches the database — SQLite maps a connection
      // into the wal-index lazily, on first access. So we issue one cheap,
      // non-transactional read here (after there's WAL content to see, and
      // before store.close()) to make idleConn a real second reader without
      // holding a transaction/snapshot that could block a TRUNCATE checkpoint.
      idleConn.pragma("user_version");

      await store.close();

      // After a TRUNCATE checkpoint the -wal file is either gone or 0 bytes.
      const wal = `${dbPath}-wal`;
      const walSize = existsSync(wal) ? statSync(wal).size : 0;
      expect(walSize).toBe(0);

      // And the row is readable from the main file alone.
      const reopened = new Database(dbPath, { readonly: true });
      const row = reopened
        .prepare("SELECT job_id FROM seen_jobs WHERE source = ?")
        .get("gh:acme") as { job_id: string } | undefined;
      reopened.close();
      expect(row?.job_id).toBe("1");
    } finally {
      idleConn.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
