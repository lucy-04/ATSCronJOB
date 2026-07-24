// Core contracts shared across adapters, notifiers, and the poller.
// Everything downstream depends on these types; keep them small and stable.

export type Ats =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workable"
  | "workday";

export type Provider = "adzuna";

/**
 * A single job posting, normalized across every source.
 * `id` is the identity used for dedup — NOT a timestamp — so a missing
 * `postedAt` never blocks new-job detection.
 */
export interface Job {
  id: string;
  title: string;
  url: string;
  location: string;
  /** Hiring company. Set by aggregator (query) sources, where it varies per job. */
  company?: string;
  department?: string;
  /** ISO-8601 when the source provides it. Display/sort only. */
  postedAt?: string;
}

interface CompanyCommon {
  kind: "company";
  /** Human display name, shown in notifications. */
  company: string;
  /** Label-only. Shown in notifications and used for sort order. Default 3. */
  tier?: number;
}

/** ATS boards whose endpoint needs a single slug/id in `token`. */
export interface SimpleSource extends CompanyCommon {
  ats: "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable";
  token: string;
}

/** Workday needs tenant + data-center shard + site, discovered via DevTools. */
export interface WorkdaySource extends CompanyCommon {
  ats: "workday";
  tenant: string;
  /** The {wdN} shard, e.g. "wd1" | "wd3" | "wd5". */
  dc: string;
  /** The careers site path, e.g. "External". */
  site: string;
}

/** A specific company's ATS board. Discriminated on `ats`. */
export type CompanySource = SimpleSource | WorkdaySource;

/** A saved title/keyword search against an aggregator (cross-company). */
export interface QuerySource {
  kind: "query";
  provider: Provider;
  /** Title/keywords to search for. */
  query: string;
  /** Location filter, e.g. "Remote" or "New York". */
  where: string;
  /** ISO country code segment for the aggregator, e.g. "us" | "gb". */
  country: string;
  /** Human nickname, shown in notifications and used for sort order. */
  label: string;
  tier?: number;
}

/** Anything the poller can fetch from. Discriminated on `kind`. */
export type Source = CompanySource | QuerySource;

/**
 * Minimal HTTP surface adapters depend on. Injected so tests can supply a fake
 * that returns a recorded fixture — no global-fetch mocking, no live network.
 */
export interface HttpClient {
  getJson<T = unknown>(url: string, init?: RequestInit): Promise<T>;
  postJson<T = unknown>(url: string, body: unknown, init?: RequestInit): Promise<T>;
}

/** Fetches a specific company's board. */
export interface CompanyAdapter {
  readonly ats: Ats;
  fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]>;
}

/** Fetches an aggregator title/keyword search. */
export interface QueryAdapter {
  readonly provider: Provider;
  fetchJobs(source: QuerySource, http: HttpClient): Promise<Job[]>;
}

/** A job paired with the source it came from, for notification rendering. */
export interface Notification {
  job: Job;
  source: Source;
}

/**
 * Batched so a burst of new roles is throttled as one operation rather than
 * one unthrottled message per job.
 */
export interface Notifier {
  notifyBatch(items: Notification[]): Promise<void>;
}
