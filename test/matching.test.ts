import { describe, expect, it } from "vitest";
import { defaultPreferences } from "../shared/defaults";
import { heuristicAnalysis, minYearsFromText, seniorityFromTitle, splitSections, visaFromText } from "../worker/matching/analyze";
import { buildCandidate, hardFilter, locationMatches, scoreJob, titleSimilarity, totalYears, type ScoringJob } from "../worker/matching/score";
import { extractSkills } from "../worker/matching/skills";
import { personal, resume } from "./fixtures";

const JD = `About the role
We build payments infrastructure.

Requirements:
- 5+ years of professional experience building backend services
- Strong TypeScript and Node.js
- PostgreSQL and AWS

Nice to have:
- Kubernetes
- Go experience is a plus

We are unable to sponsor visas for this role.`;

const job = (over: Partial<ScoringJob> = {}): ScoringJob => ({
  title: "Senior Backend Engineer",
  company: "PayCo",
  location: "Remote - US",
  workplace: "remote",
  seniority: "senior",
  salaryMin: 170000,
  salaryMax: 210000,
  salaryCurrency: "USD",
  salaryPeriod: "year",
  description: JD,
  ...over,
});

describe("analysis heuristics", () => {
  it("extracts skills without ambiguous false positives", () => {
    const s = extractSkills("We go to market fast. Rest of the team uses Python, Kubernetes and Golang.");
    expect(s).toEqual(expect.arrayContaining(["Python", "Kubernetes", "Go"]));
    expect(s).not.toContain("REST APIs");
  });
  it("splits required vs nice-to-have", () => {
    const { nice } = splitSections(JD);
    expect(nice).toContain("Kubernetes");
    const a = heuristicAnalysis({ title: "Senior Backend Engineer", description: JD, workplace: null, salary: null });
    expect(a.requiredSkills).toEqual(expect.arrayContaining(["TypeScript", "Node.js", "PostgreSQL", "AWS"]));
    expect(a.niceToHaveSkills).toContain("Kubernetes");
    expect(a.minYears).toBe(5);
    expect(a.visaSponsorship).toBe("no");
    expect(a.seniority).toBe("senior");
  });
  it("detects seniority, years and visa phrasing", () => {
    expect(seniorityFromTitle("Staff Software Engineer")).toBe("staff");
    expect(seniorityFromTitle("Software Engineering Intern")).toBe("intern");
    expect(seniorityFromTitle("Product Manager")).toBeNull();
    expect(seniorityFromTitle("Engineering Manager")).toBe("manager");
    expect(minYearsFromText("3-5 years of experience with Python")).toBe(3);
    expect(visaFromText("Candidates must be authorized to work in the US without sponsorship")).toBe("no");
    expect(visaFromText("Visa sponsorship is available for this position")).toBe("yes");
    expect(visaFromText("Great benefits")).toBe("unknown");
  });
});

describe("candidate + scoring", () => {
  const cand = buildCandidate(resume);
  const analysis = heuristicAnalysis({ title: "Senior Backend Engineer", description: JD, workplace: "remote", salary: null });

  it("computes merged years of experience", () => {
    expect(totalYears(resume, new Date("2026-01-01T00:00:00Z"))).toBeCloseTo(7.5, 0);
  });
  it("title similarity ignores seniority and handles synonyms", () => {
    expect(titleSimilarity("Sr. Backend Developer", ["backend engineer"])).toBe(1);
    expect(titleSimilarity("Account Executive", ["backend engineer"])).toBe(0);
  });
  it("matches locations", () => {
    expect(locationMatches("Austin, TX", ["United States"])).toBe(true);
    expect(locationMatches("London, UK", ["United States"])).toBe(false);
    expect(locationMatches("San Francisco, CA", ["san francisco"])).toBe(true);
  });
  it("scores a strong match highly", () => {
    const prefs = { ...defaultPreferences(), targetTitles: ["Backend Engineer"], workplace: "remote_only" as const, minSalary: 160000 };
    const { score, reasons } = scoreJob(job(), analysis, cand, prefs);
    expect(score).toBeGreaterThanOrEqual(75);
    expect(reasons.matchedSkills).toEqual(expect.arrayContaining(["TypeScript", "PostgreSQL"]));
    expect(reasons.flags).toContain("No visa sponsorship");
  });
  it("scores an unrelated job low", () => {
    const prefs = { ...defaultPreferences(), targetTitles: ["Backend Engineer"] };
    const other = heuristicAnalysis({ title: "Account Executive", description: "Requirements:\n- Salesforce\n- B2B Sales quota", workplace: null, salary: null });
    expect(scoreJob(job({ title: "Account Executive", description: "Salesforce" }), other, cand, prefs).score).toBeLessThan(40);
  });
  it("applies hard filters", () => {
    const prefs = defaultPreferences();
    expect(hardFilter(job(), analysis, { ...prefs, excludedCompanies: ["payco"] }, personal, cand)).toMatch(/Excluded/);
    expect(hardFilter(job({ workplace: "onsite", location: "London, UK" }), { ...analysis, workplace: "onsite" }, { ...prefs, workplace: "remote_only" }, personal, cand)).toMatch(/Not remote/);
    expect(hardFilter(job(), analysis, prefs, { requiresSponsorship: true }, cand)).toMatch(/sponsor/);
    expect(hardFilter(job({ salaryMax: 100000 }), analysis, { ...prefs, minSalary: 150000 }, personal, cand)).toMatch(/Salary/);
    expect(hardFilter(job({ title: "Backend Intern" }), { ...analysis, seniority: "intern" }, { ...prefs, seniority: ["senior"] }, personal, cand)).toMatch(/Seniority/);
    expect(hardFilter(job(), analysis, prefs, personal, cand)).toBeNull();
  });
});

describe("learned feedback", () => {
  const cand = buildCandidate(resume);
  const analysis = heuristicAnalysis({ title: "Senior Backend Engineer", description: JD, workplace: "remote", salary: null });
  it("penalizes roles similar to skipped ones and boosts liked ones", () => {
    const base = { ...defaultPreferences(), targetTitles: ["Backend Engineer"] };
    const neutral = scoreJob(job(), analysis, cand, base).score;
    const disliked = scoreJob(job(), analysis, cand, { ...base, learned: { liked: [], disliked: ["Senior Backend Engineer"] } });
    const liked = scoreJob(job(), analysis, cand, { ...base, learned: { liked: ["Backend Engineer II"], disliked: [] } }).score;
    expect(disliked.score).toBeLessThan(neutral);
    expect(disliked.reasons.flags).toContain("Similar to roles you skipped");
    expect(liked).toBeGreaterThanOrEqual(neutral);
  });
  it("hard-filters excluded locations for non-remote jobs only", () => {
    const prefs = { ...defaultPreferences(), excludedLocations: ["London"] };
    expect(hardFilter(job({ workplace: "onsite", location: "London, UK" }), { ...analysis, workplace: "onsite" }, prefs, personal, cand)).toMatch(/excluded/);
    expect(hardFilter(job({ workplace: "remote", location: "London, UK" }), analysis, prefs, personal, cand)).toBeNull();
  });
});
