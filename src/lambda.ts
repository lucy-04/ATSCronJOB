import { loadSources, loadRoleFilter } from "./config.js";
import { createHttpClient } from "./core/http.js";
import { createDynamoStore } from "./core/dynamo-state.js";
import { poll } from "./core/poll.js";
import { createTelegramNotifier } from "./notifiers/telegram.js";
import { consoleNotifier } from "./notifiers/console.js";
import { getTelegramCreds } from "./aws/secrets.js";
import type { Notifier } from "./core/types.js";

/**
 * Lambda entrypoint. One poll cycle against DynamoDB, delivering to Telegram.
 * STATE_TABLE is injected by Terraform; secrets come from SSM.
 */
export async function handler(): Promise<{ ok: boolean; error?: string }> {
  const tableName = process.env.STATE_TABLE;
  if (!tableName) throw new Error("STATE_TABLE env var is required");

  const http = createHttpClient();
  const store = createDynamoStore({ tableName });

  let notifier: Notifier = consoleNotifier;
  try {
    const { token, chatId } = await getTelegramCreds();
    notifier = createTelegramNotifier({ token, chatId, http });
  } catch (err) {
    console.error(`Telegram creds unavailable, falling back to console: ${(err as Error).message}`);
  }

  await poll({
    sources: loadSources(),
    http,
    store,
    notifier,
    roleFilter: loadRoleFilter(),
  });
  return { ok: true };
}
