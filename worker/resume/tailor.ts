import type { BaseResume, TailoredResume } from "../../shared/types";
import type { AiTailorOutput } from "../ai/tasks";
import { buildCandidate, resumeText, totalYears } from "../matching/score";
import { canonicalSkill, hasSkill, knownTermsIn, ngramSet } from "../matching/skills";

// Tailoring never adds content: it selects, orders and (with AI) rephrases what the user
// already wrote. AI output passes through guardAiTailoring(), which reverts any bullet or
// summary that introduces numbers or technical terms absent from the base resume.

const NUMBER_RE = /\d+(?:[.,]\d+)*\s?%?/g;

const numbersIn = (s: string) => new Set((s.match(NUMBER_RE) ?? []).map((n) => n.replace(/[\s,]/g, "")));

// Self-promotional filler that adds claims rather than restating facts.
const FILLER = /\b(demonstrat\w*|showcas\w*|highlight\w*|proven track record|passionate|results-driven|best practices|thought leader\w*|world-class|expertise in|ability to)\b/i;

const STOP = new Set(["with", "that", "this", "from", "into", "across", "using", "used", "over", "their", "they", "have", "were", "also", "which", "while", "through", "within", "years", "year", "experience"]);
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
const contentWords = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w))
    .map(stem);

/** Share of content words in `text` that never appear in `reference` (0..1). */
export function novelty(text: string, reference: string): number {
  const ref = new Set(contentWords(reference));
  const words = contentWords(text);
  if (!words.length) return 0;
  return words.filter((w) => !ref.has(w)).length / words.length;
}

function relevance(text: string, keywords: string[]): number {
  const grams = ngramSet(text);
  const empty = new Set<string>();
  let score = 0;
  for (const k of keywords) if (hasSkill(k, empty, grams)) score += 1;
  if (/\d/.test(text)) score += 0.3; // quantified impact reads better for any role
  return score;
}

function stableSortBy<T>(items: T[], key: (t: T) => number): T[] {
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((a, b) => b.k - a.k || a.i - b.i)
    .map((x) => x.item);
}

export function tailorDeterministic(resume: BaseResume, jobId: string, keywords: string[]): TailoredResume {
  const cand = buildCandidate(resume);
  const matched = keywords.filter((k) => hasSkill(k, cand.skills, cand.grams));
  const matchedLc = new Set(matched.map((m) => canonicalSkill(m).toLowerCase()));
  const changes: string[] = [];

  const skills = stableSortBy(resume.skills, (s) => (matchedLc.has(canonicalSkill(s).toLowerCase()) ? 1 : 0));
  const lead = skills.filter((s) => matchedLc.has(canonicalSkill(s).toLowerCase())).slice(0, 5);
  if (lead.length) changes.push(`Skills reordered to lead with ${lead.join(", ")}`);

  let trimmed = 0;
  let promoted = 0;
  const experience = resume.experience.map((role, idx) => {
    const cap = idx < 2 ? 6 : 4;
    const ranked = stableSortBy(role.bullets, (b) => relevance(b, matched));
    if (ranked.some((b, i) => b !== role.bullets[i])) promoted++;
    const kept = ranked.slice(0, Math.max(2, cap));
    trimmed += role.bullets.length - kept.length;
    return { ...role, bullets: kept };
  });
  if (promoted) changes.push(`Most relevant bullets moved first in ${promoted} role(s)`);
  if (trimmed) changes.push(`${trimmed} less relevant bullet(s) left out to keep the resume concise`);

  const projects = stableSortBy(resume.projects, (p) => relevance(`${p.name} ${p.bullets.join(" ")} ${p.skills.join(" ")}`, matched)).slice(0, 3);

  return {
    ...resume,
    skills,
    experience,
    projects,
    jobId,
    method: "deterministic",
    matchedKeywords: matched,
    changes,
  };
}

export function guardAiTailoring(base: BaseResume, ai: AiTailorOutput, fallback: TailoredResume): TailoredResume {
  const baseText = resumeText(base);
  const baseTerms = knownTermsIn(baseText);
  const years = totalYears(base);
  const baseNumbers = numbersIn(baseText);
  for (const y of [years, Math.floor(years), Math.round(years)]) baseNumbers.add(String(y));

  const termsOk = (text: string) => [...knownTermsIn(text)].every((t) => baseTerms.has(t));
  let reverted = 0;
  let rewritten = 0;

  // Skills: only skills the user already listed, AI order first, nothing dropped.
  const baseSkillByLc = new Map(base.skills.map((s) => [s.toLowerCase(), s]));
  const aiSkills = ai.skills.map((s) => baseSkillByLc.get(s.toLowerCase())).filter((s): s is string => !!s);
  const skills = [...new Set([...aiSkills, ...fallback.skills])];

  const experience = base.experience.map((role) => {
    const fb = fallback.experience.find((r) => r.id === role.id) ?? role;
    const aiRole = ai.experience.find((r) => r.id === role.id);
    if (!aiRole) return fb;
    const used = new Set<number>();
    const bullets: string[] = [];
    for (const b of aiRole.bullets) {
      const src = role.bullets[b.source];
      if (src === undefined || used.has(b.source)) continue;
      used.add(b.source);
      const text = b.text.trim();
      const srcNumbers = numbersIn(src);
      const ok =
        text.length > 0 &&
        text.length <= Math.max(src.length * 1.4, src.length + 40) &&
        [...numbersIn(text)].every((n) => srcNumbers.has(n)) &&
        termsOk(text) &&
        !FILLER.test(text) &&
        novelty(text, `${src}\n${baseText}`) <= 0.3;
      if (ok) {
        if (text !== src) rewritten++;
        bullets.push(text);
      } else {
        reverted++;
        bullets.push(src);
      }
    }
    if (bullets.length < Math.min(2, role.bullets.length)) return fb;
    // Keep the role as complete as the deterministic version: append original bullets the
    // model left out (in relevance order) up to the same length.
    for (const b of fb.bullets) {
      if (bullets.length >= fb.bullets.length) break;
      const idx = role.bullets.indexOf(b);
      if (!used.has(idx)) {
        used.add(idx);
        bullets.push(b);
      }
    }
    return { ...role, bullets };
  });

  const summaryText = ai.summary.trim();
  const summaryOk =
    summaryText.length > 0 &&
    summaryText.length <= 700 &&
    [...numbersIn(summaryText)].every((n) => baseNumbers.has(n)) &&
    termsOk(summaryText) &&
    !FILLER.test(summaryText) &&
    novelty(summaryText, baseText) <= 0.2;
  if (!summaryOk && summaryText) reverted++;

  const changes = [...fallback.changes.filter((c) => !c.startsWith("Most relevant"))];
  if (rewritten) changes.push(`${rewritten} bullet(s) rephrased with the job's terminology (facts unchanged)`);
  if (summaryOk && summaryText !== base.summary) changes.push("Summary rewritten for this role from your existing summary and experience");
  if (reverted) changes.push(`${reverted} AI suggestion(s) rejected by the fabrication guard and reverted to your original text`);

  return {
    ...fallback,
    summary: summaryOk ? summaryText : base.summary,
    skills,
    experience,
    method: "ai",
    changes,
  };
}
