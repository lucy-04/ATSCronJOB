import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";
import { tokenOf } from "./util.js";

// Shape of the fields we consume from the Greenhouse Job Board API.
// Endpoint: GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string } | null;
  first_published?: string | null;
  updated_at?: string | null;
  departments?: Array<{ name?: string }> | null;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

function normalize(raw: GreenhouseJob): Job {
  const department = raw.departments?.find((d) => d.name)?.name;
  return {
    id: String(raw.id),
    title: raw.title,
    url: raw.absolute_url,
    location: raw.location?.name?.trim() || "Unspecified",
    ...(department ? { department } : {}),
    ...(raw.first_published ? { postedAt: raw.first_published } : {}),
  };
}

export const greenhouseAdapter: CompanyAdapter = {
  ats: "greenhouse",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
      tokenOf(source),
    )}/jobs?content=true`;
    const data = await http.getJson<GreenhouseResponse>(url);
    return (data.jobs ?? []).map(normalize);
  },
};
