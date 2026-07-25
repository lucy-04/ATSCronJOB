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

  it("falls back to the console notifier when both secrets are absent", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    expect(chooseNotifier(http)).toBe(consoleNotifier);
  });

  it("falls back to console when only the token is set (chat id missing)", () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    delete process.env.TELEGRAM_CHAT_ID;
    expect(chooseNotifier(http)).toBe(consoleNotifier);
  });

  it("falls back to console when only the chat id is set (token missing)", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_CHAT_ID = "C";
    expect(chooseNotifier(http)).toBe(consoleNotifier);
  });
});
