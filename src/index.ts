import { loadSources, loadRoleFilter } from "./config.js";
import { createHttpClient } from "./core/http.js";
import { createSqliteStore } from "./core/state.js";
import { poll } from "./core/poll.js";
import { consoleNotifier } from "./notifiers/console.js";

// Phase 2 entrypoint: load sources, poll each supported source, dedup against
// persistent SQLite state, and print only newly-seen jobs. Telegram = later phase.
async function main(): Promise<void> {
  // STATE_DB_PATH lets CI point at the checked-out state branch copy; unset
  // locally falls through to the store's default of "state.db".
  const store = createSqliteStore({ path: process.env.STATE_DB_PATH || undefined });
  try {
    await poll({
      sources: loadSources(),
      http: createHttpClient(),
      store,
      notifier: consoleNotifier,
      roleFilter: loadRoleFilter(),
    });
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
