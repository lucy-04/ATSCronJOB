import { getAdapter, supportedAtses } from "./adapters/index.js";
import { loadTargets } from "./config.js";
import { createHttpClient } from "./core/http.js";
import { consoleNotifier } from "./notifiers/console.js";
import type { Notification } from "./core/types.js";

// Phase 1 entrypoint: load targets, fetch each supported one, and print every
// job to the console. No state, no dedup, no Telegram yet — that's Phase 2+.
async function main(): Promise<void> {
  const targets = loadTargets();
  const supported = new Set(supportedAtses());
  const http = createHttpClient();

  const found: Notification[] = [];

  for (const target of targets) {
    if (!supported.has(target.ats)) {
      console.log(`Skipping ${target.company}: adapter "${target.ats}" not implemented yet.`);
      continue;
    }
    try {
      const adapter = getAdapter(target.ats);
      const jobs = await adapter.fetchJobs(target, http);
      console.log(`${target.company} (${target.ats}): ${jobs.length} job(s)`);
      for (const job of jobs) found.push({ job, target });
    } catch (err) {
      console.error(`  ! ${target.company} failed: ${(err as Error).message}`);
    }
  }

  await consoleNotifier.notifyBatch(found);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
