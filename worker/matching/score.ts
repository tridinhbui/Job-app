import {
  SENIORITY_ORDER,
  type BaseResume,
  type JobAnalysis,
  type MatchReasons,
  type PersonalInfo,
  type Preferences,
  type Seniority,
  type Workplace,
} from "../../shared/types";
import { annualize } from "../discovery/salary";
import { clamp } from "../lib/util";
import { canonicalSkill, hasSkill, ngramSet, tokenize } from "./skills";

// Deterministic matching: hard filters first (free), then a 0-100 weighted score.
// Weights: skills 45, title 25, seniority 10, location 10, salary 10 (+ up to 5 for interests).

export interface CandidateIndex {
  skills: Set<string>;
  grams: Set<string>;
  years: number;
  titles: string[];
}

export interface ScoringJob {
  title: string;
  company: string;
  location: string | null;
  workplace: Workplace | null;
  seniority: Seniority | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  description: string;
}

const ym = (s: string): number | null => {
  const m = s.match(/^(\d{4})(?:-(\d{2}))?/);
  return m ? Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0) : null;
};

/** Total years of experience, merging overlapping roles. */
export function totalYears(resume: BaseResume, nowDate = new Date()): number {
  const current = nowDate.getUTCFullYear() * 12 + nowDate.getUTCMonth();
  const spans = resume.experience
    .map((e) => [ym(e.start), e.end ? ym(e.end) : current] as const)
    .filter((s): s is readonly [number, number] => s[0] != null && s[1] != null && s[1] >= s[0])
    .sort((a, b) => a[0] - b[0]);
  let months = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of spans) {
    if (s > curEnd) {
      if (curEnd >= 0) months += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (curEnd >= 0) months += curEnd - curStart;
  return Math.round((months / 12) * 10) / 10;
}

export function resumeText(r: BaseResume): string {
  return [
    r.headline,
    r.summary,
    r.skills.join(", "),
    ...r.experience.flatMap((e) => [e.title, e.company, ...e.bullets]),
    ...r.projects.flatMap((p) => [p.name, ...p.bullets, p.skills.join(", ")]),
    ...r.education.map((e) => `${e.degree} ${e.field} ${e.school}`),
    r.certifications.join(", "),
  ].join("\n");
}

export function buildCandidate(resume: BaseResume): CandidateIndex {
  return {
    skills: new Set(resume.skills.map((s) => canonicalSkill(s).toLowerCase())),
    grams: ngramSet(resumeText(resume)),
    years: totalYears(resume),
    titles: resume.experience.map((e) => e.title).filter(Boolean),
  };
}

// ---------- titles ----------

const TITLE_SYNONYMS: [RegExp, string][] = [
  [/\bsr\.?\b/g, "senior"],
  [/\bjr\.?\b/g, "junior"],
  [/\bswe\b/g, "software engineer"],
  [/\bsde\b/g, "software engineer"],
  [/\beng\b/g, "engineer"],
  [/\bdeveloper\b|\bdev\b/g, "engineer"],
  [/\bfront[- ]end\b/g, "frontend"],
  [/\bback[- ]end\b/g, "backend"],
  [/\bfull[- ]stack\b/g, "fullstack"],
  [/\bml\b/g, "machine learning"],
  [/\bai\b/g, "ai"],
  [/\bmgr\b/g, "manager"],
  [/\bpm\b/g, "product manager"],
  [/\bsre\b/g, "site reliability engineer"],
];
const TITLE_STOP = new Set([
  "senior", "junior", "staff", "principal", "lead", "i", "ii", "iii", "iv", "the", "and", "of", "for", "a", "an", "to", "in", "at", "with", "remote", "hybrid", "contract", "new", "grad",
]);

export function titleTokens(title: string): Set<string> {
  let t = title.toLowerCase();
  for (const [re, rep] of TITLE_SYNONYMS) t = t.replace(re, rep);
  return new Set(tokenize(t).filter((x) => !TITLE_STOP.has(x) && x.length > 1));
}

/** Fraction of the target title's tokens present in the job title (0..1). */
export function titleSimilarity(jobTitle: string, targets: string[]): number {
  const job = titleTokens(jobTitle);
  let best = 0;
  for (const target of targets) {
    const tt = titleTokens(target);
    if (tt.size === 0) continue;
    let hit = 0;
    for (const tok of tt) if (job.has(tok)) hit++;
    best = Math.max(best, hit / tt.size);
  }
  return best;
}

// ---------- location ----------

const US_STATES =
  /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const COUNTRY_ALIASES: Record<string, RegExp> = {
  "united states": /united states|\busa?\b|\bu\.s\./i,
  "united kingdom": /united kingdom|\buk\b|england|scotland|london/i,
  canada: /canada|toronto|vancouver|montreal/i,
  germany: /germany|berlin|munich/i,
};

export function locationMatches(jobLocation: string, prefs: string[]): boolean {
  const loc = jobLocation.toLowerCase();
  return prefs.some((raw) => {
    const p = raw.toLowerCase().trim();
    if (!p) return false;
    if (loc.includes(p)) return true;
    const alias = ["us", "usa", "u.s.", "united states"].includes(p) ? "united states" : p === "uk" ? "united kingdom" : p;
    if (alias === "united states" && US_STATES.test(jobLocation)) return true;
    return COUNTRY_ALIASES[alias]?.test(jobLocation) ?? false;
  });
}

// ---------- seniority ----------

export function inferSeniority(years: number): Seniority {
  if (years < 2) return "junior";
  if (years < 5) return "mid";
  if (years < 9) return "senior";
  return "staff";
}

function seniorityDistance(a: Seniority, b: Seniority) {
  return Math.abs(SENIORITY_ORDER.indexOf(a) - SENIORITY_ORDER.indexOf(b));
}

// ---------- filters & score ----------

const lc = (s: string) => s.toLowerCase().trim();

export function hardFilter(
  job: ScoringJob,
  analysis: JobAnalysis,
  prefs: Preferences,
  personal: Pick<PersonalInfo, "requiresSponsorship">,
  cand: CandidateIndex,
): string | null {
  const company = lc(job.company);
  if (prefs.excludedCompanies.some((c) => c.trim() && lc(c) === company)) return "Excluded company";
  const titleLc = ` ${lc(job.title)} `;
  const bad = prefs.excludeTitleKeywords.find((k) => k.trim() && new RegExp(`\\b${lc(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(titleLc));
  if (bad) return `Title contains excluded keyword "${bad}"`;

  const workplace = job.workplace ?? analysis.workplace;
  if (prefs.workplace === "remote_only" && workplace && workplace !== "remote") return `Not remote (${workplace})`;
  if (prefs.workplace === "remote_or_hybrid" && workplace === "onsite") return "On-site only";

  const isRemote = workplace === "remote" || /\bremote\b/i.test(job.location ?? "");
  const locPrefs = prefs.locations.filter((l) => l.trim() && lc(l) !== "remote");
  if (locPrefs.length && job.location && !isRemote && !locationMatches(job.location, locPrefs)) {
    return `Location (${job.location}) not in preferred locations`;
  }

  if (prefs.minSalary && job.salaryMax && job.salaryCurrency === prefs.salaryCurrency) {
    const annual = annualize({ min: job.salaryMin ?? job.salaryMax, max: job.salaryMax, period: (job.salaryPeriod as "year") ?? "year" });
    if (annual.max < prefs.minSalary * 0.9) return `Salary below minimum (${annual.max.toLocaleString("en-US")})`;
  }

  if (personal.requiresSponsorship && analysis.visaSponsorship === "no") return "Does not sponsor visas";

  const jobSen = analysis.seniority ?? job.seniority;
  const wanted = prefs.seniority.length ? prefs.seniority : [inferSeniority(cand.years)];
  if (jobSen && wanted.every((w) => seniorityDistance(w, jobSen) >= 3)) return `Seniority mismatch (${jobSen})`;
  return null;
}

export function scoreJob(
  job: ScoringJob,
  analysis: JobAnalysis,
  cand: CandidateIndex,
  prefs: Preferences,
): { score: number; reasons: MatchReasons } {
  const flags: string[] = [];

  // Skills (45)
  const required = analysis.requiredSkills.length ? analysis.requiredSkills : analysis.keywords;
  const nice = analysis.niceToHaveSkills.filter((s) => !required.includes(s));
  const matchedReq = required.filter((s) => hasSkill(s, cand.skills, cand.grams));
  const matchedNice = nice.filter((s) => hasSkill(s, cand.skills, cand.grams));
  const denom = required.length + 0.5 * nice.length;
  const coverage = denom > 0 ? (matchedReq.length + 0.5 * matchedNice.length) / denom : 0.5;
  const skills = 45 * coverage;

  // Title (25)
  const targets = prefs.targetTitles.length ? prefs.targetTitles : cand.titles.slice(0, 3);
  const title = 25 * (targets.length ? titleSimilarity(job.title, targets) : 0.5);

  // Seniority (10) + years gap penalty
  const jobSen = analysis.seniority ?? job.seniority;
  const wanted = prefs.seniority.length ? prefs.seniority : [inferSeniority(cand.years)];
  let seniority = 7;
  if (jobSen) {
    const d = Math.min(...wanted.map((w) => seniorityDistance(w, jobSen)));
    seniority = d === 0 ? 10 : d === 1 ? 6 : d === 2 ? 2 : 0;
  }
  if (analysis.minYears != null && analysis.minYears > cand.years + 1) {
    const gap = analysis.minYears - cand.years;
    seniority -= Math.min(10, 3 * gap);
    flags.push(`Asks for ${analysis.minYears}+ years (you have ~${cand.years})`);
  }

  // Location / workplace (10)
  const workplace = job.workplace ?? analysis.workplace;
  const locPrefs = prefs.locations.filter((l) => l.trim());
  let location = 6;
  if (workplace === "remote" && prefs.workplace !== "any") location = 10;
  else if (job.location && locPrefs.length && locationMatches(job.location, locPrefs)) location = 10;
  else if (!locPrefs.length && prefs.workplace === "any") location = 8;
  if (!workplace && prefs.workplace === "remote_only") flags.push("Remote policy not stated");

  // Salary (10)
  let salary = prefs.minSalary ? 6 : 7;
  if (prefs.minSalary && job.salaryMax) {
    if (job.salaryCurrency !== prefs.salaryCurrency) flags.push(`Salary in ${job.salaryCurrency}`);
    else {
      const annual = annualize({ min: job.salaryMin ?? job.salaryMax, max: job.salaryMax, period: (job.salaryPeriod as "year") ?? "year" });
      salary = annual.max >= prefs.minSalary ? 10 : 4;
      if (annual.max < prefs.minSalary) flags.push("Top of range is below your minimum");
    }
  }

  if (analysis.visaSponsorship === "no") flags.push("No visa sponsorship");

  // Interests bonus (≤5)
  const jdGrams = ngramSet(`${job.title}\n${job.description.slice(0, 6000)}`);
  const interestHits = prefs.interests.filter((i) => i.trim() && jdGrams.has(tokenize(i).join(" ")));
  const bonus = Math.min(5, interestHits.length * 2.5);

  const score = Math.round(clamp(skills + title + Math.max(0, seniority) + location + salary + bonus, 0, 100));
  return {
    score,
    reasons: {
      matchedSkills: [...matchedReq, ...matchedNice],
      missingSkills: required.filter((s) => !matchedReq.includes(s)),
      flags,
      breakdown: {
        skills: Math.round(skills),
        title: Math.round(title),
        seniority: Math.max(0, Math.round(seniority)),
        location: Math.round(location),
        salary: Math.round(salary),
      },
      analysis: "heuristic",
    },
  };
}
