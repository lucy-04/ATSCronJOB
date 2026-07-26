import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";
import { tokenOf } from "./util.js";

// Fields we consume from the SmartRecruiters Posting API.
// Endpoint: GET https://api.smartrecruiters.com/v1/companies/{token}/postings?limit=100
interface SmartRecruitersPosting {
  id: string;
  name: string;
  releasedDate?: string | null;
  location?: {
    city?: string | null;
    fullLocation?: string | null;
    remote?: boolean | null;
  } | null;
  department?: { label?: string | null } | null;
}

interface SmartRecruitersResponse {
  content?: SmartRecruitersPosting[];
}

function normalize(raw: SmartRecruitersPosting, token: string): Job {
  const loc = raw.location;
  const location =
    loc?.fullLocation?.trim() || loc?.city?.trim() || (loc?.remote ? "Remote" : "Unspecified");
  const department = raw.department?.label ?? undefined;
  return {
    id: String(raw.id),
    title: raw.name,
    url: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${encodeURIComponent(raw.id)}`,
    location,
    ...(department ? { department } : {}),
    ...(raw.releasedDate ? { postedAt: raw.releasedDate } : {}),
  };
}

export const smartRecruitersAdapter: CompanyAdapter = {
  ats: "smartrecruiters",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    const token = tokenOf(source);
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100`;
    const data = await http.getJson<SmartRecruitersResponse>(url);
    return (data.content ?? []).map((raw) => normalize(raw, token));
  },
};
