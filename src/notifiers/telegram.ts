import { sourceLabel } from "../adapters/util.js";
import type { HttpClient, Notification, Notifier } from "../core/types.js";

// Telegram hard-caps a message at 4096 chars; stay well under so a multi-byte
// escape or trailing block never tips a message over the edge.
const CHUNK_BUDGET = 3500;

export interface TelegramOptions {
  token: string;
  chatId: string;
  http: HttpClient;
}

// Same priority order as the console notifier: lower tier first, then label.
function byTierThenLabel(a: Notification, b: Notification): number {
  const ta = a.source.tier ?? 3;
  const tb = b.source.tier ?? 3;
  if (ta !== tb) return ta - tb;
  return sourceLabel(a.source).localeCompare(sourceLabel(b.source));
}

/** Escape the characters Telegram's HTML parse_mode treats as markup. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape a value destined for a double-quoted HTML attribute (the href of the
 * job link). Job URLs come from third-party ATS APIs, so also neutralize `"`
 * to prevent a stray quote from breaking out of the attribute.
 */
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

function renderJob({ job, source }: Notification): string {
  const tier = source.tier ?? 3;
  const who = job.company ?? sourceLabel(source);
  const dept = job.department ? ` · ${esc(job.department)}` : "";
  const title = esc(job.title);
  const link = job.url ? `<a href="${escAttr(job.url)}">${title}</a>` : title;
  return `[T${tier}] <b>${esc(who)}</b> — ${link}\n${esc(job.location)}${dept}`;
}

/** Pack rendered blocks into as few messages as possible, each under the budget. */
function chunk(blocks: string[], header: string): string[] {
  const messages: string[] = [];
  let cur = header;
  for (const block of blocks) {
    const candidate = `${cur}\n\n${block}`;
    if (candidate.length > CHUNK_BUDGET) {
      messages.push(cur);
      cur = block;
    } else {
      cur = candidate;
    }
  }
  messages.push(cur);
  return messages;
}

export function createTelegramNotifier(opts: TelegramOptions): Notifier {
  const { token, chatId, http } = opts;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return {
    async notifyBatch(items: Notification[]): Promise<void> {
      if (items.length === 0) return;
      const blocks = [...items].sort(byTierThenLabel).map(renderJob);
      const header = `<b>${items.length} new job(s)</b>`;
      const messages = chunk(blocks, header);
      for (const text of messages) {
        await http.postJson(url, {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      }
      console.log(`Sent ${items.length} job(s) to Telegram in ${messages.length} message(s).`);
    },
  };
}
