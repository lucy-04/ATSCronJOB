import { describe, it, expect } from "vitest";
import { sourceKeyOf } from "../src/adapters/util.js";
import type { Target } from "../src/core/types.js";

describe("sourceKeyOf", () => {
  it("keys a token-based target by ats and token", () => {
    const t: Target = { company: "Acme", ats: "greenhouse", token: "acme" };
    expect(sourceKeyOf(t)).toBe("greenhouse:acme");
  });

  it("keys a workday target by ats, tenant, and site", () => {
    const t: Target = { company: "Big Co", ats: "workday", tenant: "bigco", dc: "wd1", site: "External" };
    expect(sourceKeyOf(t)).toBe("workday:bigco:External");
  });

  it("is independent of the display company name", () => {
    const a: Target = { company: "Old Name", ats: "greenhouse", token: "acme" };
    const b: Target = { company: "New Name", ats: "greenhouse", token: "acme" };
    expect(sourceKeyOf(a)).toBe(sourceKeyOf(b));
  });
});
