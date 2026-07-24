import Database from "better-sqlite3";
import type { Job } from "./types.js";

/** Persistent record of which jobs we've already seen, for dedup. */
export interface StateStore {
  /** Record all fetched jobs for a source; return only the ones new to us. */
  diffAndRecord(source: string, jobs: Job[]): Job[];
  /** Remove jobs whose last_seen is older than graceDays; return rows removed. */
  prune(graceDays: number): number;
  close(): void;
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
  const deleteStale = db.prepare(`DELETE FROM seen_jobs WHERE last_seen < @cutoff`);

  return {
    diffAndRecord(source: string, jobs: Job[]): Job[] {
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

    prune(graceDays: number): number {
      const cutoff = new Date(now() - graceDays * DAY_MS).toISOString();
      return deleteStale.run({ cutoff }).changes;
    },

    close(): void {
      db.close();
    },
  };
}
