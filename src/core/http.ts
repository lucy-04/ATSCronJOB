import type { HttpClient } from "./types.js";

// A descriptive, honest User-Agent. Being identifiable is the polite default and
// makes it easy for an ATS to contact us rather than silently block.
const USER_AGENT =
  "ats-job-poller/0.1 (+https://github.com/) personal-job-search";

export interface HttpOptions {
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  userAgent?: string;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Phase 1 HTTP client: real User-Agent, timeout, JSON parsing.
 * Retry/backoff on 429/5xx is added in Phase 5 without changing this surface.
 */
export function createHttpClient(opts: HttpOptions = {}): HttpClient {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const userAgent = opts.userAgent ?? USER_AGENT;

  async function request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "user-agent": userAgent,
          accept: "application/json",
          ...init.headers,
        },
      });
      if (!res.ok) {
        throw new HttpError(
          `${init.method ?? "GET"} ${url} -> ${res.status} ${res.statusText}`,
          res.status,
          url,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getJson: <T>(url: string, init: RequestInit = {}) =>
      request<T>(url, { ...init, method: "GET" }),
    postJson: <T>(url: string, body: unknown, init: RequestInit = {}) =>
      request<T>(url, {
        ...init,
        method: "POST",
        headers: { "content-type": "application/json", ...init.headers },
        body: JSON.stringify(body),
      }),
  };
}

export { HttpError };
