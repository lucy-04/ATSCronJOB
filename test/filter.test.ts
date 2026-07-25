import { describe, it, expect } from "vitest";
import { matchesRole, filterJobs, type RoleFilter } from "../src/core/filter.js";
import type { Job } from "../src/core/types.js";

const FILTER: RoleFilter = {
  include: ["software engineer", "backend engineer", "full stack engineer", "fullstack engineer", "ai engineer", "agentic ai"],
  exclude: ["manager", "director", "vp", "vice president", "head of", "intern", "sales", "lead", "principal", "senior"],
};

function job(title: string): Job {
  return { id: title, title, url: "https://x", location: "Remote" };
}

describe("matchesRole", () => {
  it("matches a plain and a levelled include title", () => {
    expect(matchesRole("Software Engineer", FILTER)).toBe(true);
    expect(matchesRole("Backend Engineer II", FILTER)).toBe(true);
  });
  it("matches punctuation/spacing variants of full stack", () => {
    expect(matchesRole("Full-Stack Engineer", FILTER)).toBe(true);
    expect(matchesRole("Fullstack Engineer", FILTER)).toBe(true);
  });
  it("matches Agentic AI and AI Engineer", () => {
    expect(matchesRole("Agentic AI Engineer", FILTER)).toBe(true);
    expect(matchesRole("AI Engineer", FILTER)).toBe(true);
  });
  it("excludes management/senior/sales even when an include term is present", () => {
    expect(matchesRole("Software Engineering Manager", FILTER)).toBe(false); // "manager"
    expect(matchesRole("Senior Backend Engineer", FILTER)).toBe(false);      // "senior"
    expect(matchesRole("Principal Software Engineer", FILTER)).toBe(false);  // "principal"
    expect(matchesRole("Lead Software Engineer", FILTER)).toBe(false);       // "lead"
  });
  it("drops titles with no include term", () => {
    expect(matchesRole("Account Executive", FILTER)).toBe(false);
    expect(matchesRole("Product Designer", FILTER)).toBe(false);
  });
  it("does not false-match the short exclude 'vp' inside a word", () => {
    // "devpost" contains the substring "vp" but is not a whole-word 'vp'
    expect(matchesRole("Backend Engineer, Devpost", FILTER)).toBe(true);
  });
  it("empty include list matches everything", () => {
    expect(matchesRole("Anything At All", { include: [], exclude: ["manager"] })).toBe(true);
  });
});

describe("filterJobs", () => {
  it("keeps only matching jobs", () => {
    const jobs = [job("Backend Engineer"), job("Engineering Manager"), job("AI Engineer"), job("Recruiter")];
    expect(filterJobs(jobs, FILTER).map((j) => j.title)).toEqual(["Backend Engineer", "AI Engineer"]);
  });
  it("returns all jobs when include is empty", () => {
    const jobs = [job("Anything"), job("Sales Rep")];
    expect(filterJobs(jobs, { include: [], exclude: [] })).toEqual(jobs);
  });
});
