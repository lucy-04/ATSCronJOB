import { getAdapter, supportedAtses } from "../adapters/index.js";
import { sourceKeyOf } from "../adapters/util.js";
import type { HttpClient, Notification, Notifier, Target } from "./types.js";
import type { StateStore } from "./state.js";

export interface PollDeps {
  targets: Target[];
  http: HttpClient;
  store: StateStore;
  notifier: Notifier;
  /** Prune window in days. Default 14. */
  graceDays?: number;
}

const DEFAULT_GRACE_DAYS = 14;

/**
 * One poll cycle: fetch each supported target, dedup against the store, prune
 * stale entries once, and notify only the jobs new to us. Per-target failures
 * are isolated — one bad fetch never aborts the run.
 */
export async function poll(deps: PollDeps): Promise<void> {
  const { targets, http, store, notifier } = deps;
  const graceDays = deps.graceDays ?? DEFAULT_GRACE_DAYS;
  const supported = new Set(supportedAtses());
  const found: Notification[] = [];

  for (const target of targets) {
    if (!supported.has(target.ats)) {
      console.log(`Skipping ${target.company}: adapter "${target.ats}" not implemented yet.`);
      continue;
    }
    try {
      const adapter = getAdapter(target.ats);
      const jobs = await adapter.fetchJobs(target, http);
      const newJobs = store.diffAndRecord(sourceKeyOf(target), jobs);
      console.log(`${target.company} (${target.ats}): ${jobs.length} job(s), ${newJobs.length} new`);
      for (const job of newJobs) found.push({ job, target });
    } catch (err) {
      console.error(`  ! ${target.company} failed: ${(err as Error).message}`);
    }
  }

  const removed = store.prune(graceDays);
  if (removed > 0) console.log(`Pruned ${removed} stale job(s).`);

  await notifier.notifyBatch(found);
}
