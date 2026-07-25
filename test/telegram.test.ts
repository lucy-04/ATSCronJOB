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

  it("escapes a double-quote in the job URL so it can't break out of the href attribute", async () => {
    const { http, calls } = recorder();
    await createTelegramNotifier({ token: "T", chatId: "C", http }).notifyBatch([
      note("Backend Engineer", { url: 'https://x/a"onmouseover="evil' }),
    ]);
    const text: string = calls[0]!.body.text;
    expect(text).toContain('href="https://x/a&quot;onmouseover=&quot;evil"');
    // The raw quote must not survive inside the attribute value.
    expect(text).not.toContain('href="https://x/a"onmouseover');
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
