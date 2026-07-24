import { loadTargets } from "./config.js";
import { createHttpClient } from "./core/http.js";
import { createSqliteStore } from "./core/state.js";
import { poll } from "./core/poll.js";
import { consoleNotifier } from "./notifiers/console.js";

// Phase 2 entrypoint: load targets, poll each supported source, dedup against
// persistent SQLite state, and print only newly-seen jobs. Telegram = later phase.
async function main(): Promise<void> {
  const store = createSqliteStore();
  try {
    await poll({
      targets: loadTargets(),
      http: createHttpClient(),
      store,
      notifier: consoleNotifier,
    });
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
