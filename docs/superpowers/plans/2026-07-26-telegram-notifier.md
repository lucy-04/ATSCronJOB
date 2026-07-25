# Phase 6 — Telegram Notifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Push newly-found jobs to Telegram (not just the console), so the hourly cron actually reaches the user's phone.

**Architecture:** A new `createTelegramNotifier({ token, chatId, http })` factory implementing the existing `Notifier` interface (`notifyBatch`). It renders the same job info the console notifier shows, HTML-escaped, and sends via `http.postJson` to the Telegram Bot API `sendMessage` endpoint — chunked so each message fits Telegram's 4096-char limit. `src/index.ts` selects Telegram when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set, else falls back to the console notifier. The dedup/prune/poll/filter engine and all adapters are reused untouched.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, vitest, tsx. Telegram Bot HTTP API (key via env/secret).

**Reference:** Telegram Bot API `sendMessage` — `POST https://api.telegram.org/bot{TOKEN}/sendMessage` with JSON body `{ chat_id, text, parse_mode, disable_web_page_preview }`; HTML `parse_mode` requires escaping `&`, `<`, `>`.

## Global Constraints

- Node >= 20; ESM (`"type":"module"`) — relative imports use `.js` extensions; `import type` for type-only imports (`verbatimModuleSyntax`).
- No new dependencies (use the injected `HttpClient`, never global fetch, so tests stay offline).
- Tests under `test/`, run with `npx vitest run`; `npm run typecheck` stays clean (strict, `noUncheckedIndexedAccess`).
- The notifier is DI-shaped: `createTelegramNotifier({ token, chatId, http })`. No secret is read inside the notifier — the entrypoint reads env and injects.
- Empty batch ⇒ send NOTHING (no Telegram call, no spam). Behavior when Telegram is unconfigured must be identical to today (console notifier).
- Each Telegram message must be ≤ 4096 chars; a burst of many new jobs is split across multiple messages.

---

### Task 1: Telegram notifier core

**Files:**
- Create: `src/notifiers/telegram.ts`, `test/telegram.test.ts`

**Interfaces:**
- Consumes: `HttpClient, Notification, Notifier` from `../core/types.js`; `sourceLabel` from `../adapters/util.js`.
- Produces:
  - `interface TelegramOptions { token: string; chatId: string; http: HttpClient }`
  - `createTelegramNotifier(opts: TelegramOptions): Notifier`

- [ ] **Step 1: Write `test/telegram.test.ts` (RED)**

```ts
import { describe, it, expect } from "vitest";
import { createTelegramNotifier } from "../src/notifiers/telegram.js";
import type { HttpClient, Notification, Source } from "../src/core/types.js";

const company: Source = { kind: "company", company: "Acme", ats: "greenhouse", token: "acme", tier: 1 };

interface Call { url: string; body: any }

// Fake HTTP that records every postJson call; getJson is unused.
function recorder(): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpClient = {
    async getJson<T>(): Promise<T> { throw new Error("getJson not used by Telegram"); },
    async postJson<T>(url: string, body: unknown): Promise<T> {
      calls.push({ url, body });
      return { ok: true } as T;
    },
  };
  return { http, calls };
}

function note(title: string, extra: Partial<Notification["job"]> = {}): Notification {
  return { job: { id: title, title, url: `https://x/${title}`, location: "Remote", ...extra }, source: company };
}

describe("createTelegramNotifier", () => {
  it("sends nothing for an empty batch", async () => {
    const { http, calls } = recorder();
    await createTelegramNotifier({ token: "T", chatId: "C", http }).notifyBatch([]);
    expect(calls).toEqual([]);
  });

  it("posts to the sendMessage endpoint with the token and chat id", async () => {
    const { http, calls } = recorder();
    await createTelegramNotifier({ token: "SECRET", chatId: "12345", http }).notifyBatch([note("Backend Engineer")]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/botSECRET/sendMessage");
    expect(calls[0]!.body.chat_id).toBe("12345");
    expect(calls[0]!.body.parse_mode).toBe("HTML");
    expect(calls[0]!.body.disable_web_page_preview).toBe(true);
    // Contains a header count, the company, the title as a link, and location.
    expect(calls[0]!.body.text).toContain("1 new job(s)");
    expect(calls[0]!.body.text).toContain("Acme");
    expect(calls[0]!.body.text).toContain('<a href="https://x/Backend Engineer">Backend Engineer</a>');
    expect(calls[0]!.body.text).toContain("Remote");
  });

  it("HTML-escapes titles/company/location so parse_mode HTML stays valid", async () => {
    const { http, calls } = recorder();
    await createTelegramNotifier({ token: "T", chatId: "C", http }).notifyBatch([
      note("C++ & <Backend> Engineer", { location: "R&D <HQ>" }),
    ]);
    const text: string = calls[0]!.body.text;
    // Raw special chars must not appear unescaped inside the rendered content.
    expect(text).toContain("C++ &amp; &lt;Backend&gt; Engineer");
    expect(text).toContain("R&amp;D &lt;HQ&gt;");
    expect(text).not.toContain("<Backend>");
  });

  it("splits a large burst into multiple messages, each within the 4096 limit", async () => {
    const { http, calls } = recorder();
    // 300 jobs with long-ish titles guarantees the text exceeds one message.
    const many = Array.from({ length: 300 }, (_, i) => note(`Backend Engineer number ${i} with a fairly long descriptive title`));
    await createTelegramNotifier({ token: "T", chatId: "C", http }).notifyBatch(many);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.body.text.length).toBeLessThanOrEqual(4096);
    }
    // Every job appears somewhere across the messages.
    const all = calls.map((c) => c.body.text).join("\n");
    expect(all).toContain("number 0 ");
    expect(all).toContain("number 299 ");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — cannot find `../src/notifiers/telegram.js`.

- [ ] **Step 3: Write `src/notifiers/telegram.ts`**

```ts
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

function renderJob({ job, source }: Notification): string {
  const tier = source.tier ?? 3;
  const who = job.company ?? sourceLabel(source);
  const dept = job.department ? ` · ${esc(job.department)}` : "";
  const title = esc(job.title);
  const link = job.url ? `<a href="${esc(job.url)}">${title}</a>` : title;
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
```

Note: `chunk` seeds the first message with `header` and always appends at least the header, so an empty-block call (never reached — guarded by the `items.length === 0` return) would still be well-formed. A single block longer than the budget is pushed as its own message; job titles are far shorter than 3500 chars, so this stays within Telegram's limit in practice.

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `npx vitest run test/telegram.test.ts` → PASS (all).
Run: `npx vitest run` → full suite green.
Run: `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/notifiers/telegram.ts test/telegram.test.ts
git commit -m "feat: add Telegram notifier (HTML, chunked to message limit)"
```

---

### Task 2: Wire notifier selection + secrets + docs

**Files:**
- Modify: `src/index.ts`, `.github/workflows/poll.yml`, `docs/deployment.md`
- Test: `test/index-notifier.test.ts` (create) — unit-test the selection helper

**Interfaces:**
- Consumes: `createTelegramNotifier` (Task 1); `consoleNotifier` (existing).
- Produces: `chooseNotifier(http: HttpClient): Notifier` exported from `src/index.ts` — Telegram when both env vars are set, else console.

- [ ] **Step 1: Refactor `src/index.ts` to select the notifier (make the choice testable)**

Add imports:
```ts
import { createTelegramNotifier } from "./notifiers/telegram.js";
import type { HttpClient, Notifier } from "./core/types.js";
```
Add an exported, pure-ish selection helper (reads env, but takes `http` injected):
```ts
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
```
Update `main()` to build one `http` and use the helper:
```ts
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
```
Also update the stale top-of-file comment ("Telegram = later phase.") to reflect that Telegram is now wired.

- [ ] **Step 2: Write `test/index-notifier.test.ts` (RED first)**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { chooseNotifier } from "../src/index.js";
import type { HttpClient } from "../src/core/types.js";

const http: HttpClient = {
  async getJson<T>(): Promise<T> { throw new Error("unused"); },
  async postJson<T>(): Promise<T> { throw new Error("unused"); },
};

describe("chooseNotifier", () => {
  const saved = { t: process.env.TELEGRAM_BOT_TOKEN, c: process.env.TELEGRAM_CHAT_ID };
  afterEach(() => {
    if (saved.t === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = saved.t;
    if (saved.c === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = saved.c;
  });

  it("returns a Telegram notifier when both secrets are set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    process.env.TELEGRAM_CHAT_ID = "C";
    const n = chooseNotifier(http);
    // The console notifier is a shared singleton; Telegram is a fresh object.
    expect(typeof n.notifyBatch).toBe("function");
    expect(n).not.toBe(consoleSingleton());
  });

  it("falls back to the console notifier when secrets are absent", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    expect(chooseNotifier(http)).toBe(consoleSingleton());
  });
});

// Imported lazily to compare identity with the fallback.
function consoleSingleton() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (globalThis as any).__none__ ?? require("../src/notifiers/console.js").consoleNotifier;
}
```
NOTE for implementer: `require` is not available under ESM. Instead import `consoleNotifier` at the top: `import { consoleNotifier } from "../src/notifiers/console.js";` and replace `consoleSingleton()` with `consoleNotifier`. Simplify the test to:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { chooseNotifier } from "../src/index.js";
import { consoleNotifier } from "../src/notifiers/console.js";
import type { HttpClient } from "../src/core/types.js";

const http: HttpClient = {
  async getJson<T>(): Promise<T> { throw new Error("unused"); },
  async postJson<T>(): Promise<T> { throw new Error("unused"); },
};

describe("chooseNotifier", () => {
  const saved = { t: process.env.TELEGRAM_BOT_TOKEN, c: process.env.TELEGRAM_CHAT_ID };
  afterEach(() => {
    if (saved.t === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = saved.t;
    if (saved.c === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = saved.c;
  });

  it("returns a Telegram notifier (not the console singleton) when both secrets are set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    process.env.TELEGRAM_CHAT_ID = "C";
    const n = chooseNotifier(http);
    expect(typeof n.notifyBatch).toBe("function");
    expect(n).not.toBe(consoleNotifier);
  });

  it("falls back to the console notifier when either secret is absent", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    expect(chooseNotifier(http)).toBe(consoleNotifier);
  });
});
```
Use this simplified version (delete the `require`-based draft above).

IMPORTANT: importing `../src/index.js` runs `main()` as a side effect today (the file calls `main()` at top level). To make `chooseNotifier` importable without launching a poll, guard the entrypoint call so it only runs when the module is executed directly, not when imported:
```ts
import { fileURLToPath } from "node:url";
// ...only auto-run when invoked as the script, not when imported by a test.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
```
(Replace the existing unconditional `main().catch(...)` block with this guarded version.)

- [ ] **Step 3: Run the selection test**

Run: `npx vitest run test/index-notifier.test.ts` → PASS both cases.
Run: `npx vitest run` → full suite green (importing index.js must NOT trigger a real poll — the `isMain` guard ensures this).

- [ ] **Step 4: Add Telegram secrets to the workflow**

In `.github/workflows/poll.yml`, in the "Run poller" step's `env:` block (alongside `STATE_DB_PATH` and the Adzuna keys), add:
```yaml
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
```
(Do not change anything else in the workflow.)

- [ ] **Step 5: Document Telegram setup in `docs/deployment.md`**

Append:
```markdown
## Telegram notifications

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are both set, the poller sends
new jobs to Telegram instead of printing them; without them it falls back to the
console (local runs, or CI before you add the secrets).

Setup:
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the
   **bot token** it gives you.
2. Start a chat with your new bot and send it any message (a bot cannot message
   you first).
3. Get your **chat id**: open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `result[].message.chat.id` (a number; negative for groups).
4. Add both as GitHub repo secrets (Settings → Secrets and variables → Actions):
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
5. Locally, export the same two env vars before `npm start` to test delivery.

Messages use HTML formatting and are split to stay within Telegram's
4096-character per-message limit when a run finds many new roles.
```

- [ ] **Step 6: Full suite + typecheck + commit**

Run: `npx vitest run` → green. `npm run typecheck` → clean.
```bash
git add src/index.ts test/index-notifier.test.ts .github/workflows/poll.yml docs/deployment.md
git commit -m "feat: send to Telegram when configured; console fallback"
```

---

## Self-Review

**Spec coverage:**
- Telegram notifier via `Notifier.notifyBatch`, DI-shaped, using `http.postJson` → Task 1. ✓
- Empty batch sends nothing → Task 1 test. ✓
- HTML escaping for parse_mode safety → Task 1 (`esc`) + test. ✓
- Chunking to ≤4096 → Task 1 (`chunk`, `CHUNK_BUDGET`) + burst test. ✓
- Env-based selection with console fallback, unchanged behavior when unconfigured → Task 2 (`chooseNotifier`) + test. ✓
- Secrets injected via workflow env → Task 2 Step 4. ✓
- Setup docs (BotFather, chat id, secrets) → Task 2 Step 5. ✓
- No secret read inside the notifier (entrypoint reads env, injects) → Task 1 signature + Task 2 helper. ✓

**Placeholder scan:** none. The Task 2 test has a documented "use the simplified version" — implementer writes the second (ESM-correct) block.

**Type consistency:** `TelegramOptions { token; chatId; http }`, `createTelegramNotifier(opts): Notifier`, `chooseNotifier(http): Notifier` are consistent across Task 1/2 and tests. `esc`/`renderJob`/`chunk` are private to the notifier module.

**Known limitation (documented, not a defect):** a single job block exceeding `CHUNK_BUDGET` is sent as one over-budget message; real titles are far shorter, so this is out of scope (YAGNI). If ever hit, a later phase can truncate individual blocks.
