import type { JobAnalysis, Seniority, Workplace } from "../../shared/types";
import type { Salary } from "../discovery/types";
import { uniq } from "../lib/util";
import { extractSkills } from "./skills";

// Heuristic (zero-cost) job description analysis. AI analysis (worker/ai/tasks.ts) only
// refines this for promising jobs, and its result is cached per job content hash.

export function seniorityFromTitle(title: string): Seniority | null {
  const t = title.toLowerCase();
  if (/\b(intern|internship|co-?op)\b/.test(t)) return "intern";
  if (/\b(chief|cto|ceo|cfo|coo|vp|vice president|svp|evp)\b/.test(t)) return "executive";
  if (/\bdirector\b|\bhead of\b/.test(t)) return "director";
  if (/\bprincipal\b|\bdistinguished\b|\bfellow\b/.test(t)) return "principal";
  if (/\bstaff\b/.test(t)) return "staff";
  if (/\bmanager\b|\bmgr\b/.test(t) && !/\b(product|program|project|account|community|marketing)\s+manager\b/.test(t)) return "manager";
  if (/\b(senior|sr\.?|lead)\b|\biii\b|\biv\b/.test(t)) return "senior";
  if (/\b(junior|jr\.?|entry[- ]level|graduate|new grad|associate)\b|\bi\b/.test(t)) return "junior";
  if (/\bii\b/.test(t)) return "mid";
  return null;
}

export function workplaceFromText(text: string): Workplace | null {
  const t = text.toLowerCase();
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(fully remote|100% remote|remote[- ]first|work from anywhere|remote \(|remote,|this (role|position) is remote|remote within)\b/.test(t)) return "remote";
  if (/\b(on-?site|in[- ]office|in the office) (\d|five|four|three)/.test(t) || /\bon-?site\b/.test(t)) return "onsite";
  return null;
}

const NO_SPONSOR = [
  /\b(unable|not able|cannot|can ?not|can't|will not|won't|do not|does not|doesn't|don't|are not able to|is not able to|no)\s+(to\s+)?(offer|provide|sponsor|support)\w*\s+(any\s+)?(employment\s+)?(visa|work\s+authori[sz]ation|sponsorship|immigration|h-?1b)/i,
  /\bwithout\s+(the\s+need\s+for\s+)?(current\s+or\s+future\s+)?(visa\s+|employer\s+|employment\s+)?sponsorship/i,
  /\bsponsorship\s+(is\s+)?(not\s+available|unavailable|not\s+offered|not\s+provided)/i,
  /\bnot\s+(eligible|open)\s+(for|to)\s+(visa\s+)?sponsorship/i,
];
const YES_SPONSOR = [
  /\b(visa|immigration)\s+sponsorship\s+(is\s+)?(available|offered|provided)/i,
  /\bwe\s+(do\s+|will\s+|can\s+)?(sponsor|offer\s+visa\s+sponsorship|provide\s+visa\s+sponsorship)/i,
  /\bopen\s+to\s+sponsor/i,
];

export function visaFromText(text: string): JobAnalysis["visaSponsorship"] {
  if (NO_SPONSOR.some((r) => r.test(text))) return "no";
  if (YES_SPONSOR.some((r) => r.test(text))) return "yes";
  return "unknown";
}

export function minYearsFromText(text: string): number | null {
  const re = /(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?\+?\s*years?(?:'|’)?(?:\s+of)?[^.\n]{0,60}?(experience|industry|professional|working)/gi;
  let min: number | null = null;
  for (const m of text.matchAll(re)) {
    const n = parseInt(m[1]!, 10);
    if (n >= 1 && n <= 25) min = min == null ? n : Math.min(min, n);
  }
  return min;
}

const NICE_HEADING = /(nice[- ]to[- ]have|preferred|bonus|plus|would be great|ideal(ly)?|extra credit|stand out)/i;
const REQ_HEADING = /(requirement|qualification|you have|you bring|what we.re looking for|must[- ]have|about you|who you are|skills|experience)/i;

/** Split description into "required" and "nice-to-have" text using section headings. */
export function splitSections(text: string): { required: string; nice: string } {
  let mode: "req" | "nice" = "req";
  const req: string[] = [];
  const nice: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const isHeading = trimmed.length > 0 && trimmed.length < 90 && !/^-/.test(trimmed) && (/:$/.test(trimmed) || !/[.!?]$/.test(trimmed));
    if (isHeading) {
      if (NICE_HEADING.test(trimmed)) mode = "nice";
      else if (REQ_HEADING.test(trimmed)) mode = "req";
    }
    // Inline markers on bullet lines ("Bonus: experience with Rust")
    if (/^-\s*(bonus|nice to have|preferred|a plus)/i.test(trimmed) || /\b(is a plus|a big plus|nice to have)\b/i.test(trimmed)) {
      nice.push(trimmed);
      continue;
    }
    (mode === "nice" ? nice : req).push(trimmed);
  }
  return { required: req.join("\n"), nice: nice.join("\n") };
}

export function heuristicAnalysis(job: {
  title: string;
  description: string;
  workplace: Workplace | null;
  salary: Salary | null;
}): JobAnalysis {
  const { required, nice } = splitSections(job.description);
  const reqSkills = extractSkills(`${job.title}\n${required}`);
  const niceSkills = extractSkills(nice).filter((s) => !reqSkills.includes(s));
  return {
    requiredSkills: reqSkills.slice(0, 25),
    niceToHaveSkills: niceSkills.slice(0, 15),
    minYears: minYearsFromText(job.description),
    seniority: seniorityFromTitle(job.title),
    workplace: job.workplace ?? workplaceFromText(job.description),
    visaSponsorship: visaFromText(job.description),
    salary: job.salary,
    keywords: uniq([...reqSkills, ...niceSkills]).slice(0, 30),
    summary: "",
  };
}
