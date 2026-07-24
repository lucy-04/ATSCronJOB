import type { HttpClient, Job, QueryAdapter, QuerySource } from "../core/types.js";

// Fields we consume from the Adzuna Search API.
// Endpoint: GET api.adzuna.com/v1/api/jobs/{country}/search/1?app_id=..&app_key=..&what=..&where=..
interface AdzunaJob {
  id: string | number;
  title: string;
  redirect_url: string;
  location?: { display_name?: string } | null;
  company?: { display_name?: string } | null;
  created?: string | null;
}

interface AdzunaResponse {
  results: AdzunaJob[];
}

function normalize(raw: AdzunaJob): Job {
  const company = raw.company?.display_name?.trim();
  return {
    id: String(raw.id),
    title: raw.title,
    url: raw.redirect_url,
    location: raw.location?.display_name?.trim() || "Unspecified",
    ...(company ? { company } : {}),
    ...(raw.created ? { postedAt: raw.created } : {}),
  };
}

export const adzunaAdapter: QueryAdapter = {
  provider: "adzuna",
  async fetchJobs(source: QuerySource, http: HttpClient): Promise<Job[]> {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      throw new Error("Missing ADZUNA_APP_ID / ADZUNA_APP_KEY environment variables");
    }
    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      what: source.query,
      where: source.where,
      "content-type": "application/json",
    });
    const url = `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(
      source.country,
    )}/search/1?${params.toString()}`;
    const data = await http.getJson<AdzunaResponse>(url);
    return (data.results ?? []).map(normalize);
  },
};
