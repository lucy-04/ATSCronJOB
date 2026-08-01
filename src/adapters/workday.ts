import type { CompanyAdapter, HttpClient, Job, CompanySource } from "../core/types.js";

// Fields we consume from the Workday Candidate-Experience (CxS) API.
// Endpoint: POST https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
interface WorkdayJob {
  title: string;
  externalPath: string;
  locationsText?: string | null;
  bulletFields?: string[] | null;
}

interface WorkdayResponse {
  total?: number;
  jobPostings?: WorkdayJob[];
}

const PAGE = 20;
const MAX_PAGES = 25; // cap at ~500 jobs/source per run

function normalize(raw: WorkdayJob, base: string, site: string): Job {
  const id = raw.bulletFields?.[0] ?? raw.externalPath;
  return {
    id: String(id),
    title: raw.title,
    url: `${base}/en-US/${site}${raw.externalPath}`,
    location: raw.locationsText?.trim() || "India",
  };
}

export const workdayAdapter: CompanyAdapter = {
  ats: "workday",
  async fetchJobs(source: CompanySource, http: HttpClient): Promise<Job[]> {
    if (source.ats !== "workday") {
      throw new Error(`workdayAdapter received a non-workday source (${source.ats})`);
    }
    const { tenant, dc, site } = source;
    const searchText = source.searchText ?? "";
    const base = `https://${tenant}.${dc}.myworkdayjobs.com`;
    const url = `${base}/wday/cxs/${tenant}/${site}/jobs`;

    const jobs: Job[] = [];
    let offset = 0;
    let total = Infinity;
    for (let page = 0; page < MAX_PAGES && offset < total; page++) {
      const data = await http.postJson<WorkdayResponse>(url, {
        appliedFacets: {},
        limit: PAGE,
        offset,
        searchText,
      });
      const postings = data.jobPostings ?? [];
      if (postings.length === 0) break;
      for (const p of postings) jobs.push(normalize(p, base, site));
      total = typeof data.total === "number" ? data.total : jobs.length;
      offset += PAGE;
    }
    return jobs;
  },
};
