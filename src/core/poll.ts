import {
  getCompanyAdapter,
  getQueryAdapter,
  supportedAtses,
  supportedProviders,
} from "../adapters/index.js";
import { sourceKeyOf, sourceLabel } from "../adapters/util.js";
import type { HttpClient, Job, Notification, Notifier, Source } from "./types.js";
import type { StateStore } from "./state.js";
import { filterJobs } from "./filter.js";
import type { RoleFilter } from "./filter.js";

export interface PollDeps {
  sources: Source[];
  http: HttpClient;
  store: StateStore;
  notifier: Notifier;
  /** Prune window in days. Default 14. */
  graceDays?: number;
  /** Optional global title filter, applied to company sources only. */
  roleFilter?: RoleFilter;
}

const DEFAULT_GRACE_DAYS = 14;

/** Fetch one source's jobs, or throw. Dispatches on kind so each adapter stays typed. */
async function fetchSource(source: Source, http: HttpClient): Promise<Job[]> {
  if (source.kind === "query") {
    return getQueryAdapter(source.provider).fetchJobs(source, http);
  }
  return getCompanyAdapter(source.ats).fetchJobs(source, http);
}

/** True if we have an adapter for this source's kind. */
function isSupported(source: Source, atses: Set<string>, providers: Set<string>): boolean {
  return source.kind === "query" ? providers.has(source.provider) : atses.has(source.ats);
}

/** Per-kind detail suffix for the summary line: the ATS for company sources, the provider for query sources. */
function sourceDetail(source: Source): string {
  return source.kind === "query" ? source.provider : source.ats;
}

/**
 * One poll cycle: fetch each supported source, dedup against the store, prune
 * (only sources that fetched OK), and notify only the jobs new to us. Per-source
 * failures are isolated — one bad fetch never aborts the run.
 */
export async function poll(deps: PollDeps): Promise<void> {
  const { sources, http, store, notifier, roleFilter } = deps;
  const graceDays = deps.graceDays ?? DEFAULT_GRACE_DAYS;
  const atses = new Set<string>(supportedAtses());
  const providers = new Set<string>(supportedProviders());
  const found: Notification[] = [];
  const okSources: string[] = [];

  for (const source of sources) {
    const label = sourceLabel(source);
    if (!isSupported(source, atses, providers)) {
      const which = source.kind === "query" ? `provider "${source.provider}"` : `adapter "${source.ats}"`;
      console.log(`Skipping ${label}: ${which} not implemented yet.`);
      continue;
    }
    try {
      let jobs = await fetchSource(source, http);
      if (source.kind === "company" && roleFilter) {
        jobs = filterJobs(jobs, roleFilter);
      }
      const key = sourceKeyOf(source);
      const newJobs = await store.diffAndRecord(key, jobs);
      okSources.push(key);
      console.log(`${label} (${sourceDetail(source)}): ${jobs.length} job(s), ${newJobs.length} new`);
      for (const job of newJobs) found.push({ job, source });
    } catch (err) {
      console.error(`  ! ${label} failed: ${(err as Error).message}`);
    }
  }

  const removed = await store.prune(graceDays, okSources);
  if (removed > 0) console.log(`Pruned ${removed} stale job(s).`);

  // Deliberately NOT wrapped in try/catch: a delivery failure (e.g. Telegram
  // returning non-2xx) must propagate so main() exits non-zero. In the cron
  // workflow that skips the "Persist state" step, so the state branch does not
  // advance and this batch is re-detected and re-delivered next run
  // (at-least-once). Swallowing the error would let state persist and silently
  // drop the batch. Fast-follow: record-after-notify so local `npm start` runs
  // (which reuse the same local state.db) also get at-least-once delivery.
  await notifier.notifyBatch(found);
}
