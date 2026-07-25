import { fileURLToPath } from "node:url";
import { loadSources, loadRoleFilter } from "./config.js";
import { createHttpClient } from "./core/http.js";
import { createSqliteStore } from "./core/state.js";
import { poll } from "./core/poll.js";
import { consoleNotifier } from "./notifiers/console.js";
import { createTelegramNotifier } from "./notifiers/telegram.js";
import type { HttpClient, Notifier } from "./core/types.js";

// Phase 2 entrypoint: load sources, poll each supported source, dedup against
// persistent SQLite state, and notify (Telegram when configured, else console).
async function main(): Promise<void> {
  // STATE_DB_PATH lets CI point at the checked-out state branch copy; unset
  // locally falls through to the store's default of "state.db".
  const store = createSqliteStore({ path: process.env.STATE_DB_PATH || undefined });
  const http = createHttpClient();
  try {
    await poll({
      sources: loadSources(),
      http,
      store,
      notifier: chooseNotifier(http),
      roleFilter: loadRoleFilter(),
    });
  } finally {
    store.close();
  }
}

/**
 * Telegram when both secrets are present, else the console notifier (local runs
 * and CI without secrets). Exported for testing.
 */
export function chooseNotifier(http: HttpClient): Notifier {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    return createTelegramNotifier({ token, chatId, http });
  }
  return consoleNotifier;
}

// Only auto-run when invoked as the script, not when imported by a test.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
