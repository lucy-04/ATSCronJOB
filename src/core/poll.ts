import {
  getCompanyAdapter,
  getQueryAdapter,
  supportedAtses,
  supportedProviders,
} from "../adapters/index.js";
import { sourceKeyOf, sourceLabel } from "../adapters/util.js";
import type { HttpClient, Job, Notification, Notifier, Source } from "./types.js";
import type { StateStore } from "./state.js";

export interface PollDeps {
  sources: Source[];
  http: HttpClient;
  store: StateStore;
  notifier: Notifier;
  /** Prune window in days. Default 14. */
  graceDays?: number;
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

/**
 * One poll cycle: fetch each supported source, dedup against the store, prune
 * (only sources that fetched OK), and notify only the jobs new to us. Per-source
 * failures are isolated — one bad fetch never aborts the run.
 */
export async function poll(deps: PollDeps): Promise<void> {
  const { sources, http, store, notifier } = deps;
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
      const jobs = await fetchSource(source, http);
      const key = sourceKeyOf(source);
      const newJobs = store.diffAndRecord(key, jobs);
      okSources.push(key);
      console.log(`${label}: ${jobs.length} job(s), ${newJobs.length} new`);
      for (const job of newJobs) found.push({ job, source });
    } catch (err) {
      console.error(`  ! ${label} failed: ${(err as Error).message}`);
    }
  }

  const removed = store.prune(graceDays, okSources);
  if (removed > 0) console.log(`Pruned ${removed} stale job(s).`);

  await notifier.notifyBatch(found);
}
