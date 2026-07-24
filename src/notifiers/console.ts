import { sourceLabel } from "../adapters/util.js";
import type { Notification, Notifier } from "../core/types.js";

// Sorts by tier (lower = higher priority) then label, so the most important
// roles print first. Used for local runs and as a fallback notifier.
function byTierThenLabel(a: Notification, b: Notification): number {
  const ta = a.source.tier ?? 3;
  const tb = b.source.tier ?? 3;
  if (ta !== tb) return ta - tb;
  return sourceLabel(a.source).localeCompare(sourceLabel(b.source));
}

export const consoleNotifier: Notifier = {
  async notifyBatch(items: Notification[]): Promise<void> {
    if (items.length === 0) {
      console.log("No new jobs.");
      return;
    }
    console.log(`\n${items.length} new job(s):\n`);
    for (const { job, source } of [...items].sort(byTierThenLabel)) {
      const tier = source.tier ?? 3;
      // Hiring company: aggregator jobs carry it per-job; company sources use the label.
      const who = job.company ?? sourceLabel(source);
      const dept = job.department ? ` · ${job.department}` : "";
      console.log(`  [T${tier}] ${who} — ${job.title}`);
      console.log(`        ${job.location}${dept}`);
      console.log(`        ${job.url}`);
    }
    console.log("");
  },
};
