// Core contracts shared across adapters, notifiers, and the poller.
// Everything downstream depends on these types; keep them small and stable.

export type Ats =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workable"
  | "workday";

/**
 * A single job posting, normalized across every ATS.
 * `id` is the identity used for dedup — NOT a timestamp — so a missing
 * `postedAt` never blocks new-job detection.
 */
export interface Job {
  id: string;
  title: string;
  url: string;
  location: string;
  department?: string;
  /** ISO-8601 when the ATS provides it. Display/sort only. */
  postedAt?: string;
}

interface CommonTarget {
  /** Human display name, shown in notifications. */
  company: string;
  /** Label-only. Shown in notifications and used for sort order. Default 3. */
  tier?: number;
}

/**
 * Adapters whose endpoint needs a single slug/id. `token` carries whatever
 * string the ATS's URL expects: Greenhouse board token, Lever slug, Ashby
 * token, SmartRecruiters company id, or Workable account token.
 */
export interface SimpleTarget extends CommonTarget {
  ats: "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable";
  token: string;
}

/** Workday needs tenant + data-center shard + site, discovered via DevTools. */
export interface WorkdayTarget extends CommonTarget {
  ats: "workday";
  tenant: string;
  /** The {wdN} shard, e.g. "wd1" | "wd3" | "wd5". */
  dc: string;
  /** The careers site path, e.g. "External". */
  site: string;
}

/** Discriminated on `ats`. */
export type Target = SimpleTarget | WorkdayTarget;

/**
 * Minimal HTTP surface adapters depend on. Injected so tests can supply a fake
 * that returns a recorded fixture — no global-fetch mocking, no live network.
 */
export interface HttpClient {
  getJson<T = unknown>(url: string, init?: RequestInit): Promise<T>;
  postJson<T = unknown>(url: string, body: unknown, init?: RequestInit): Promise<T>;
}

export interface Adapter {
  readonly ats: Ats;
  fetchJobs(target: Target, http: HttpClient): Promise<Job[]>;
}

/** A job paired with the target it came from, for notification rendering. */
export interface Notification {
  job: Job;
  target: Target;
}

/**
 * Batched so a burst of new roles is throttled as one operation rather than
 * one unthrottled message per job.
 */
export interface Notifier {
  notifyBatch(items: Notification[]): Promise<void>;
}
