import Database from "better-sqlite3";
import type { Job } from "./types.js";

/** Persistent record of which jobs we've already seen, for dedup. */
export interface StateStore {
  /** Record all fetched jobs for a source; return only the ones new to us. */
  diffAndRecord(source: string, jobs: Job[]): Promise<Job[]>;
  /** Remove jobs (only for the given sources) whose last_seen is older than graceDays; return rows removed. */
  prune(graceDays: number, sources: string[]): Promise<number>;
  close(): Promise<void>;
}

export interface SqliteStoreOptions {
  /** DB file path. Default "state.db". Pass ":memory:" in tests. */
  path?: string;
  /** Epoch-ms clock, injectable for deterministic tests. Default Date.now. */
  now?: () => number;
}

const DAY_MS = 86_400_000;

export function createSqliteStore(opts: SqliteStoreOptions = {}): StateStore {
  const db = new Database(opts.path ?? "state.db");
  const now = opts.now ?? Date.now;

  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      source     TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seen_jobs (
      source     TEXT NOT NULL,
      job_id     TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      PRIMARY KEY (source, job_id)
    );
  `);

  const sourceExists = db.prepare(`SELECT 1 FROM sources WHERE source = ?`);
  const insertSource = db.prepare(
    `INSERT INTO sources (source, first_seen) VALUES (@source, @now)`,
  );
  const selectIds = db.prepare(`SELECT job_id FROM seen_jobs WHERE source = ?`);
  const upsert = db.prepare(`
    INSERT INTO seen_jobs (source, job_id, first_seen, last_seen)
    VALUES (@source, @jobId, @now, @now)
    ON CONFLICT(source, job_id) DO UPDATE SET last_seen = @now
  `);
  const deleteStaleForSource = db.prepare(
    `DELETE FROM seen_jobs WHERE source = @source AND last_seen < @cutoff`,
  );

  return {
    async diffAndRecord(source: string, jobs: Job[]): Promise<Job[]> {
      const nowIso = new Date(now()).toISOString();
      const tx = db.transaction((): Job[] => {
        // "New source" is tracked in `sources`, NOT by row count — so a source
        // pruned down to zero jobs is still known, and reappearing jobs re-notify.
        const isNewSource = sourceExists.get(source) === undefined;
        if (isNewSource) insertSource.run({ source, now: nowIso });

        const existing = new Set(
          (selectIds.all(source) as Array<{ job_id: string }>).map((r) => r.job_id),
        );
        const newJobs = isNewSource ? [] : jobs.filter((j) => !existing.has(j.id));

        for (const j of jobs) upsert.run({ source, jobId: j.id, now: nowIso });

        return newJobs;
      });
      return tx();
    },

    // Only prunes the given sources — a source whose fetch failed this run is
    // omitted by the caller, so its jobs are never mistaken for "gone."
    async prune(graceDays: number, sources: string[]): Promise<number> {
      if (sources.length === 0) return 0;
      const cutoff = new Date(now() - graceDays * DAY_MS).toISOString();
      const run = db.transaction((srcs: string[]): number => {
        let removed = 0;
        for (const source of srcs) {
          removed += deleteStaleForSource.run({ source, cutoff }).changes;
        }
        return removed;
      });
      return run(sources);
    },

    async close(): Promise<void> {
      // Fold any WAL writes into state.db and truncate the -wal file, so a
      // committed state.db (Phase 3 persistence) is always complete on its own.
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
