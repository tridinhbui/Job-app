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
  /** Per-role n-grams with a recency weight (1.0 = current/recent role). */
  roles: { title: string; grams: Set<string>; weight: number; years: number }[];
  projectGrams: Set<string>;
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

export function buildCandidate(resume: BaseResume, nowDate = new Date()): CandidateIndex {
  const current = nowDate.getUTCFullYear() * 12 + nowDate.getUTCMonth();
  const roles = resume.experience.map((e) => {
    const start = ym(e.start);
    const end = e.end ? ym(e.end) : current;
    // Skills used recently count fully; evidence fades ~6% per year since the role ended, but
    // never below 0.7 — real use always beats merely listing a skill (0.6).
    const yearsAgo = end != null ? Math.max(0, (current - end) / 12) : 5;
    return {
      title: e.title,
      grams: ngramSet(`${e.title}\n${e.bullets.join("\n")}`),
      weight: Math.max(0.7, 1 - 0.06 * yearsAgo),
      years: start != null && end != null && end >= start ? (end - start) / 12 : 0,
    };
  });
  return {
    skills: new Set(resume.skills.map((s) => canonicalSkill(s).toLowerCase())),
    grams: ngramSet(resumeText(resume)),
    years: totalYears(resume),
    titles: resume.experience.map((e) => e.title).filter(Boolean),
    roles,
    projectGrams: ngramSet(resume.projects.flatMap((p) => [p.name, ...p.bullets, p.skills.join(", ")]).join("\n")),
  };
}

/**
 * How strongly the resume evidences a skill (0..1): used in a recent role > used in an older
 * role > only listed in skills/projects > absent. Keyword presence alone is not full credit.
 */
export function skillEvidence(skill: string, cand: CandidateIndex): number {
  const empty = new Set<string>();
  let best = 0;
  for (const r of cand.roles) if (r.weight > best && hasSkill(skill, empty, r.grams)) best = r.weight;
  if (best > 0) return best;
  if (hasSkill(skill, cand.skills, cand.projectGrams)) return 0.6;
  return hasSkill(skill, empty, cand.grams) ? 0.5 : 0;
}

/** Years spent in roles similar to the target/job title (relevant experience). */
export function relevantYears(cand: CandidateIndex, titles: string[]): number {
  if (!titles.length) return cand.years;
  const yrs = cand.roles.filter((r) => titleSimilarity(r.title, titles) >= 0.5).reduce((a, r) => a + r.years, 0);
  return Math.round(Math.min(yrs, cand.years) * 10) / 10;
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
  const badLoc = prefs.excludedLocations.find((l) => l.trim() && job.location && !isRemote && job.location.toLowerCase().includes(lc(l)));
  if (badLoc) return `Location excluded (${badLoc})`;
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

export interface ScoreContext {
  requiresSponsorship?: boolean;
  country?: string;
  /** Semantic resume↔job fit (0..1) from embeddings; null when unavailable. */
  semantic?: number | null;
}

/**
 * Weighted, explainable score (0-100):
 *   skills 30 (evidence-weighted) · semantic 15 · title 15 · experience 10 · seniority 10 ·
 *   location 10 · salary 10 · plus interest bonus and learned feedback.
 * Without an embedding the remaining 85 points are rescaled to 100.
 */
export function scoreJob(job: ScoringJob, analysis: JobAnalysis, cand: CandidateIndex, prefs: Preferences, ctx: ScoreContext = {}): { score: number; reasons: MatchReasons } {
  const flags: string[] = [];

  // Skills (30): required count double; each skill weighted by how strongly the resume shows it.
  const required = analysis.requiredSkills.length ? analysis.requiredSkills : analysis.keywords;
  const nice = analysis.niceToHaveSkills.filter((s) => !required.includes(s));
  const evReq = required.map((s) => skillEvidence(s, cand));
  const evNice = nice.map((s) => skillEvidence(s, cand));
  const matchedReq = required.filter((_, i) => evReq[i]! > 0);
  const matchedNice = nice.filter((_, i) => evNice[i]! > 0);
  const denom = required.length + 0.5 * nice.length;
  const coverage = denom > 0 ? (evReq.reduce((a, b) => a + b, 0) + 0.5 * evNice.reduce((a, b) => a + b, 0)) / denom : 0.5;
  const skills = 30 * coverage;
  const listedOnly = required.filter((_, i) => evReq[i]! > 0 && evReq[i]! <= 0.6);
  if (listedOnly.length >= 2) flags.push(`Listed but not shown in your experience: ${listedOnly.slice(0, 3).join(", ")}`);

  // Title (15)
  const targets = prefs.targetTitles.length ? prefs.targetTitles : cand.titles.slice(0, 3);
  const title = 15 * (targets.length ? titleSimilarity(job.title, targets) : 0.5);

  // Experience (10): relevant years vs. what the posting asks for.
  const relevant = relevantYears(cand, [job.title, ...targets]);
  const effective = Math.max(relevant, cand.years * 0.6);
  let experience = 7;
  if (analysis.minYears != null) {
    const gap = analysis.minYears - effective;
    experience = gap <= 0 ? 10 : gap <= 1 ? 7 : gap <= 3 ? 3 : 0;
    if (gap > 1) flags.push(`Asks for ${analysis.minYears}+ years (you have ~${Math.round(effective)} relevant)`);
    if (effective > analysis.minYears + 8) flags.push("You may be overqualified for this level");
  }

  // Seniority (10)
  const jobSen = analysis.seniority ?? job.seniority;
  const wanted = prefs.seniority.length ? prefs.seniority : [inferSeniority(cand.years)];
  let seniority = 7;
  if (jobSen) {
    const d = Math.min(...wanted.map((w) => seniorityDistance(w, jobSen)));
    seniority = d === 0 ? 10 : d === 1 ? 6 : d === 2 ? 2 : 0;
  }

  // Location / workplace (10)
  const workplace = job.workplace ?? analysis.workplace;
  const locPrefs = prefs.locations.filter((l) => l.trim());
  let location = 6;
  if (workplace === "remote" && prefs.workplace !== "any") location = 10;
  else if (job.location && locPrefs.length && locationMatches(job.location, locPrefs)) location = 10;
  else if (!locPrefs.length && prefs.workplace === "any") location = 8;
  if (!workplace && prefs.workplace === "remote_only") flags.push("Remote policy not stated");
  // "Remote — EU only" style restrictions that exclude the user's country.
  const restricted = job.location?.match(/remote[^;|]*?\b(us|usa|united states|eu|europe|uk|canada|emea|apac|latam)\b/i)?.[1];
  if (restricted && ctx.country && !locationMatches(restricted, [ctx.country]) && !locationMatches(ctx.country, [restricted])) {
    location = Math.min(location, 3);
    flags.push(`Remote limited to ${restricted.toUpperCase()}`);
  }

  // Salary (10)
  let salary = prefs.minSalary ? 6 : 7;
  if (prefs.minSalary && job.salaryMax) {
    if (job.salaryCurrency !== prefs.salaryCurrency) flags.push(`Salary in ${job.salaryCurrency}`);
    else {
      const annual = annualize({ min: job.salaryMin ?? job.salaryMax, max: job.salaryMax, period: (job.salaryPeriod as "year") ?? "year" });
      salary = annual.min >= prefs.minSalary ? 10 : annual.max >= prefs.minSalary ? 8 : 3;
      if (annual.max < prefs.minSalary) flags.push("Top of range is below your minimum");
    }
  }

  // Visa
  let visaAdj = 0;
  if (analysis.visaSponsorship === "no") flags.push("No visa sponsorship");
  if (ctx.requiresSponsorship && analysis.visaSponsorship === "unknown") {
    visaAdj = -4;
    flags.push("Visa sponsorship not stated");
  }
  if (ctx.requiresSponsorship && analysis.visaSponsorship === "yes") flags.push("Sponsors visas");

  // Semantic (15)
  const semantic = ctx.semantic != null ? 15 * ctx.semantic : null;

  // Interests bonus (≤5)
  const jdGrams = ngramSet(`${job.title}\n${job.description.slice(0, 6000)}`);
  const interestHits = prefs.interests.filter((i) => i.trim() && jdGrams.has(tokenize(i).join(" ")));
  const bonus = Math.min(5, interestHits.length * 2.5);

  // Feedback learned from what you prepared vs. skipped for the role.
  let feedback = 0;
  if (prefs.learned.liked.length && titleSimilarity(job.title, prefs.learned.liked) >= 0.8) feedback += 5;
  if (prefs.learned.disliked.length && titleSimilarity(job.title, prefs.learned.disliked) >= 0.8) {
    feedback -= 15;
    flags.push("Similar to roles you skipped");
  }

  const base = skills + title + experience + seniority + location + salary;
  const core = semantic != null ? base + semantic : (base / 85) * 100;
  const score = Math.round(clamp(core + bonus + feedback + visaAdj, 0, 100));
  return {
    score,
    reasons: {
      matchedSkills: [...matchedReq, ...matchedNice],
      missingSkills: required.filter((s) => !matchedReq.includes(s)),
      flags,
      breakdown: {
        skills: Math.round(skills),
        semantic: semantic != null ? Math.round(semantic) : null,
        title: Math.round(title),
        experience: Math.round(experience),
        seniority: Math.round(seniority),
        location: Math.round(location),
        salary: Math.round(salary),
      },
      analysis: "heuristic",
    },
  };
}
