import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";
import { tokenOf } from "./util.js";

// Fields we consume from the Lever postings API.
// Endpoint: GET https://api.lever.co/v0/postings/{token}?mode=json  (bare array)
interface LeverJob {
  id: string;
  text: string;
  hostedUrl?: string | null;
  applyUrl?: string | null;
  createdAt?: number | null;
  workplaceType?: string | null;
  categories?: {
    department?: string | null;
    location?: string | null;
  } | null;
}

function normalize(raw: LeverJob): Job {
  const loc = raw.categories?.location?.trim();
  const location = loc || (raw.workplaceType === "remote" ? "Remote" : "Unspecified");
  const department = raw.categories?.department ?? undefined;
  const postedAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? new Date(raw.createdAt).toISOString()
      : undefined;
  return {
    id: String(raw.id),
    title: raw.text,
    url: raw.hostedUrl ?? raw.applyUrl ?? "",
    location,
    ...(department ? { department } : {}),
    ...(postedAt ? { postedAt } : {}),
  };
}

export const leverAdapter: CompanyAdapter = {
  ats: "lever",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(tokenOf(source))}?mode=json`;
    const data = await http.getJson<unknown>(url);
    return (Array.isArray(data) ? (data as LeverJob[]) : []).map(normalize);
  },
};
