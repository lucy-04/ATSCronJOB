import type { Notification, Notifier } from "../core/types.js";

// Sorts by tier (lower = higher priority) then company, so the most important
// roles print first. Used for local runs and as a fallback notifier.
function byTierThenCompany(a: Notification, b: Notification): number {
  const ta = a.target.tier ?? 3;
  const tb = b.target.tier ?? 3;
  if (ta !== tb) return ta - tb;
  return a.target.company.localeCompare(b.target.company);
}

export const consoleNotifier: Notifier = {
  async notifyBatch(items: Notification[]): Promise<void> {
    if (items.length === 0) {
      console.log("No new jobs.");
      return;
    }
    console.log(`\n${items.length} new job(s):\n`);
    for (const { job, target } of [...items].sort(byTierThenCompany)) {
      const tier = target.tier ?? 3;
      const dept = job.department ? ` · ${job.department}` : "";
      console.log(`  [T${tier}] ${target.company} — ${job.title}`);
      console.log(`        ${job.location}${dept}`);
      console.log(`        ${job.url}`);
    }
    console.log("");
  },
};
