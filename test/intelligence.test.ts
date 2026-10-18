import { describe, expect, it } from "vitest";
import { defaultPreferences, emptyResume } from "../shared/defaults";
import type { BaseResume, FormField, PreparedAnswer, TailoredResume } from "../shared/types";
import { buildReport, checkAnswers, checkResume, unsupportedClaims } from "../worker/apply/quality";
import { cosine, fromB64, semanticFit, toB64 } from "../worker/matching/embeddings";
import { heuristicAnalysis } from "../worker/matching/analyze";
import { buildCandidate, relevantYears, scoreJob, skillEvidence, type ScoringJob } from "../worker/matching/score";
import { resume } from "./fixtures";

const NOW = new Date("2026-10-01T00:00:00Z");
const job = (over: Partial<ScoringJob> = {}): ScoringJob => ({
  title: "Senior Backend Engineer",
  company: "PayCo",
  location: "Remote - US",
  workplace: "remote",
  seniority: "senior",
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  description: "Requirements:\n- PostgreSQL\n- Docker\n- Kubernetes\n- 5+ years of experience",
  ...over,
});

describe("evidence-based skills", () => {
  const cand = buildCandidate(resume, NOW);
  it("weights skills by where and how recently they were used", () => {
    expect(skillEvidence("PostgreSQL", cand)).toBe(1); // in the current role's bullets
    expect(skillEvidence("Docker", cand)).toBeGreaterThan(0.6); // older role, decayed but above "listed only"
    expect(skillEvidence("Docker", cand)).toBeLessThan(1);
    expect(skillEvidence("AWS", cand)).toBeGreaterThan(0.6);
    expect(skillEvidence("Kubernetes", cand)).toBe(0);
    const listedOnly: BaseResume = { ...emptyResume(), skills: ["Rust"], experience: [{ id: "r", company: "X", title: "Engineer", location: "", start: "2020-01", end: "", bullets: ["Built web services"] }] };
    expect(skillEvidence("Rust", buildCandidate(listedOnly, NOW))).toBe(0.6);
  });
  it("counts relevant years from similar roles", () => {
    expect(relevantYears(cand, ["Software Engineer"])).toBeGreaterThan(7);
    expect(relevantYears(cand, ["Product Designer"])).toBe(0);
  });
});

describe("weighted score", () => {
  const cand = buildCandidate(resume, NOW);
  const analysis = heuristicAnalysis({ title: "Senior Backend Engineer", description: job().description, workplace: "remote", salary: null });
  const prefs = { ...defaultPreferences(), targetTitles: ["Backend Engineer"] };
  it("uses semantic similarity when available", () => {
    const high = scoreJob(job(), analysis, cand, prefs, { semantic: 1 });
    const low = scoreJob(job(), analysis, cand, prefs, { semantic: 0 });
    const none = scoreJob(job(), analysis, cand, prefs, {});
    expect(high.score - low.score).toBe(15);
    expect(none.reasons.breakdown.semantic).toBeNull();
    expect(none.score).toBeGreaterThan(low.score);
    expect(none.score).toBeLessThan(high.score);
  });
  it("flags visa uncertainty and restricted remote roles", () => {
    const visa = scoreJob(job(), analysis, cand, prefs, { requiresSponsorship: true });
    expect(visa.reasons.flags).toContain("Visa sponsorship not stated");
    const eu = scoreJob(job({ location: "Remote - EU" }), analysis, cand, prefs, { country: "United States" });
    expect(eu.reasons.flags).toContain("Remote limited to EU");
    expect(eu.reasons.breakdown.location).toBeLessThanOrEqual(3);
  });
});

describe("embedding helpers", () => {
  it("round-trips vectors and scores similarity", () => {
    const v = [0.1, -0.2, 0.3];
    expect(fromB64(toB64(v)).map((x) => Math.round(x * 1000) / 1000)).toEqual(v);
    expect(cosine(v, v)).toBeCloseTo(1);
    expect(semanticFit(0.4)).toBe(0);
    expect(semanticFit(0.9)).toBe(1);
  });
});

describe("application quality", () => {
  const field = (key: string, label: string, type: FormField["type"], options: string[] = []): FormField => ({ key, label, type, required: true, options: options.map((o) => ({ label: o, value: o })), description: "", section: "main" });
  const ans = (key: string, label: string, type: PreparedAnswer["type"], value: string | string[], source: PreparedAnswer["source"] = "user"): PreparedAnswer => ({ key, label, type, required: true, value, source, needsReview: false });
  it("blocks missing, invalid and placeholder answers; warns on unsupported claims", () => {
    const fields = [field("a", "Sponsorship?", "select", ["Yes", "No"]), field("b", "Why PayCo?", "textarea"), field("c", "Name", "text"), field("d", "Describe a project", "textarea")];
    const answers = [
      ans("a", "Sponsorship?", "select", "Maybe"),
      ans("b", "Why PayCo?", "textarea", "I love [Company] and its mission to build great payment products for everyone."),
      ans("c", "Name", "text", ""),
      ans("d", "Describe a project", "textarea", "I led a team of 25 engineers building Kubernetes operators for a fintech platform.", "ai"),
    ];
    const checks = checkAnswers(fields, answers, { resume, company: "PayCo" });
    const ids = checks.filter((c) => !c.ok).map((c) => `${c.id}:${c.severity}`);
    expect(ids).toEqual(expect.arrayContaining(["option:block", "placeholder:block", "required:block", "claims:warn"]));
    expect(buildReport(checks).blocking).toBe(3);
    expect(unsupportedClaims("I mentored 4 engineers using Node.js", resume)).toEqual([]);
  });
  it("audits the tailored resume independently", () => {
    const ok: TailoredResume = { ...resume, jobId: "j", method: "ai", matchedKeywords: ["PostgreSQL"], changes: [] };
    expect(checkResume(resume, ok, { email: "a@b.c", phone: "1" }).every((c) => c.ok)).toBe(true);
    const bad: TailoredResume = { ...ok, skills: [...resume.skills, "Kubernetes"], summary: "Engineer with 15 years of experience." };
    const failed = checkResume(resume, bad, { email: "a@b.c", phone: "1" }).filter((c) => !c.ok);
    expect(failed.map((c) => c.id)).toEqual(["fabrication", "fabrication"]);
  });
});
