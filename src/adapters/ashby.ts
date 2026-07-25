import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";
import { tokenOf } from "./util.js";

// Fields we consume from the Ashby public job-board posting API.
// Endpoint: GET https://api.ashbyhq.com/posting-api/job-board/{token}
interface AshbyJob {
  id: string;
  title: string;
  location?: string | null;
  department?: string | null;
  jobUrl?: string | null;
  applyUrl?: string | null;
  isRemote?: boolean | null;
  isListed?: boolean;
  publishedAt?: string | null;
}

interface AshbyResponse {
  jobs?: AshbyJob[];
}

function normalize(raw: AshbyJob): Job {
  const location = raw.location?.trim() || (raw.isRemote ? "Remote" : "Unspecified");
  return {
    id: String(raw.id),
    title: raw.title,
    url: raw.jobUrl ?? raw.applyUrl ?? "",
    location,
    ...(raw.department ? { department: raw.department } : {}),
    ...(raw.publishedAt ? { postedAt: raw.publishedAt } : {}),
  };
}

export const ashbyAdapter: CompanyAdapter = {
  ats: "ashby",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(tokenOf(source))}`;
    const data = await http.getJson<AshbyResponse>(url);
    return (data.jobs ?? []).filter((j) => j.isListed !== false).map(normalize);
  },
};
