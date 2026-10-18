import type { BaseResume, FormField, PreparedAnswer, TailoredResume } from "../../shared/types";
import { resumeText, totalYears } from "../matching/score";
import { knownTermsIn, tokenize } from "../matching/skills";

// Application quality report. Deterministic checks (no AI) run after preparation and again
// whenever answers change. "block" findings prevent approval; "warn" findings are shown to the
// user. The resume audit is independent of the tailoring guard, as a second line of defence.

export interface QualityCheck {
  id: string;
  ok: boolean;
  severity: "block" | "warn" | "info";
  message: string;
  field?: string;
}

export interface QualityReport {
  score: number;
  blocking: number;
  warnings: number;
  checks: QualityCheck[];
}

const NUMBER_RE = /\d+(?:[.,]\d+)*\s?%?/g;
const numbersIn = (s: string) => new Set((s.match(NUMBER_RE) ?? []).map((n) => n.replace(/[\s,]/g, "")));
const PLACEHOLDER = /\[(company|name|role|position|your [a-z]+)\]|lorem ipsum|\bTODO\b|\{\{.*?\}\}|<insert/i;
const STOP = new Set(["what", "your", "with", "have", "this", "that", "please", "describe", "would", "about", "tell", "from", "will", "there", "they", "their", "which", "when", "where", "does", "were", "been", "into", "more", "some"]);
const content = (s: string) => new Set(tokenize(s).filter((w) => w.length >= 4 && !STOP.has(w)));
const isEmpty = (v: string | string[]) => (Array.isArray(v) ? v.length === 0 : !v.trim());

/** Numbers / known tools mentioned in `text` that the resume never mentions. */
export function unsupportedClaims(text: string, resume: BaseResume): string[] {
  const base = resumeText(resume);
  const baseNumbers = numbersIn(base);
  const years = totalYears(resume);
  for (const y of [years, Math.floor(years), Math.round(years)]) baseNumbers.add(String(y));
  const baseTerms = knownTermsIn(base);
  const claims = [...numbersIn(text)].filter((n) => !baseNumbers.has(n) && !/^(19|20)\d\d$/.test(n));
  claims.push(...[...knownTermsIn(text)].filter((t) => !baseTerms.has(t)));
  return claims;
}

export function checkAnswers(fields: FormField[], answers: PreparedAnswer[], ctx: { resume: BaseResume; company: string }): QualityCheck[] {
  const checks: QualityCheck[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const seenText = new Map<string, string>();

  for (const a of answers) {
    const f = byKey.get(a.key);
    const v = a.value;
    if (a.required && a.type !== "file" && isEmpty(v)) {
      checks.push({ id: "required", ok: false, severity: "block", field: a.label, message: `Required question has no answer: ${a.label}` });
      continue;
    }
    if (isEmpty(v) || a.type === "file") continue;

    if ((a.type === "select" || a.type === "multiselect") && f?.options.length) {
      const labels = new Set(f.options.map((o) => o.label));
      const bad = (Array.isArray(v) ? v : [v]).filter((x) => !labels.has(x));
      if (bad.length) checks.push({ id: "option", ok: false, severity: "block", field: a.label, message: `"${bad.join(", ")}" is not one of the allowed options` });
      continue;
    }
    const text = Array.isArray(v) ? v.join(", ") : v;
    if (PLACEHOLDER.test(text)) checks.push({ id: "placeholder", ok: false, severity: "block", field: a.label, message: "Answer contains placeholder text" });
    if (a.type === "text" && text.length > 255) checks.push({ id: "length", ok: false, severity: "block", field: a.label, message: `Too long for a single-line field (${text.length}/255 characters)` });
    if (a.type === "textarea" && text.trim().length < 20 && a.required) checks.push({ id: "short", ok: false, severity: "warn", field: a.label, message: "Very short answer for an open question" });

    if (a.type === "textarea" || a.source === "ai") {
      const claims = unsupportedClaims(text, ctx.resume);
      if (claims.length) checks.push({ id: "claims", ok: false, severity: "warn", field: a.label, message: `Mentions things not in your resume: ${claims.slice(0, 5).join(", ")}` });
      // Motivation questions should talk about this employer.
      const company = ctx.company.toLowerCase().split(/[\s,(]/)[0] ?? "";
      if (/\bwhy\b|interest|motivat/i.test(a.label) && company.length > 2 && !text.toLowerCase().includes(company)) {
        checks.push({ id: "relevance", ok: false, severity: "warn", field: a.label, message: `Doesn't mention ${ctx.company}` });
      } else {
        const q = content(a.label);
        const ans = content(text);
        if (q.size >= 3 && ![...q].some((w) => ans.has(w)) && a.source === "ai") {
          checks.push({ id: "relevance", ok: false, severity: "warn", field: a.label, message: "May not address the question asked" });
        }
      }
      const norm = text.trim().toLowerCase();
      if (norm.length > 40 && seenText.has(norm)) checks.push({ id: "duplicate", ok: false, severity: "warn", field: a.label, message: `Same answer as "${seenText.get(norm)}"` });
      seenText.set(norm, a.label);
    }
  }
  if (!checks.some((c) => !c.ok)) checks.push({ id: "answers", ok: true, severity: "info", message: `${answers.length} answers checked` });
  return checks;
}

export function checkResume(base: BaseResume, tailored: TailoredResume | null, contact: { email: string; phone: string }): QualityCheck[] {
  const checks: QualityCheck[] = [];
  if (!contact.email) checks.push({ id: "contact", ok: false, severity: "block", message: "Your email is missing from your profile" });
  if (!contact.phone) checks.push({ id: "contact", ok: false, severity: "warn", message: "Your phone number is missing from your profile" });
  if (!tailored) return checks;

  // Independent fabrication audit of the final resume.
  const baseSkills = new Set(base.skills.map((s) => s.toLowerCase()));
  const extraSkills = tailored.skills.filter((s) => !baseSkills.has(s.toLowerCase()));
  if (extraSkills.length) checks.push({ id: "fabrication", ok: false, severity: "block", message: `Skills not in your resume: ${extraSkills.join(", ")}` });
  const baseRoles = new Map(base.experience.map((e) => [e.id, e]));
  for (const role of tailored.experience) {
    const src = baseRoles.get(role.id);
    if (!src || src.company !== role.company || src.title !== role.title || src.start !== role.start || src.end !== role.end) {
      checks.push({ id: "fabrication", ok: false, severity: "block", message: `Role "${role.title} at ${role.company}" differs from your resume` });
    }
  }
  const claims = unsupportedClaims([tailored.summary, ...tailored.experience.flatMap((e) => e.bullets)].join("\n"), base);
  if (claims.length) checks.push({ id: "fabrication", ok: false, severity: "block", message: `Resume mentions things not in your original: ${claims.slice(0, 6).join(", ")}` });
  if (!checks.some((c) => c.id === "fabrication")) checks.push({ id: "fabrication", ok: true, severity: "info", message: "Resume contains only facts from your original" });
  if (tailored.matchedKeywords.length) checks.push({ id: "keywords", ok: true, severity: "info", message: `Covers ${tailored.matchedKeywords.length} of the job's keywords` });
  return checks;
}

export function buildReport(checks: QualityCheck[]): QualityReport {
  const blocking = checks.filter((c) => !c.ok && c.severity === "block").length;
  const warnings = checks.filter((c) => !c.ok && c.severity === "warn").length;
  return { score: Math.max(0, 100 - blocking * 25 - warnings * 8), blocking, warnings, checks };
}
