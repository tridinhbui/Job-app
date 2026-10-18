import type { BaseResume, JobAnalysis, MatchReasons, Seniority, Workplace } from "../../shared/types";
import { aiAllowed } from "../ai/client";
import { aiAnalyzeJob, aiMatchReasoning } from "../ai/tasks";
import { createApplication, eventStmt } from "../db/applications";
import { getProfile, setWatermark } from "../db/profile";
import type { Env } from "../env";
import { chunk, now, safeJson, uniq } from "../lib/util";
import { heuristicAnalysis } from "./analyze";
import { buildCandidate, hardFilter, scoreJob, type CandidateIndex, type ScoreContext, type ScoringJob } from "./score";
import { cosine, jobVectors, resumeVector, semanticFit } from "./embeddings";
import { canonicalSkill } from "./skills";

const PAGE = 150;
const MAX_AI_ANALYSES_PER_RUN = 8;
const MAX_AI_REASONING_PER_RUN = 5;
const AMBIGUOUS_LOW = 50;
const AMBIGUOUS_HIGH = 74;
const LEASE_MS = 3 * 60 * 1000;

interface JobRow {
  id: string;
  title: string;
  company: string;
  location: string | null;
  workplace: Workplace | null;
  seniority: Seniority | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  description: string;
  content_hash: string;
  dedupe_key: string;
  updated_at: number;
  a_hash: string | null;
  a_method: string | null;
  a_json: string | null;
}

export interface MatchRunResult {
  evaluated: number;
  stored: number;
  filtered: number;
  aiAnalyses: number;
  aiReasoned: number;
  shortlisted: number;
  more: boolean;
  cursor: MatchCursor | null;
  embedded: number;
  skipped?: string;
}

/** Keyset cursor: one crawl stamps many jobs with the same updated_at, so (time, id) is needed. */
export interface MatchCursor {
  t: number;
  id: string;
}

const toScoringJob = (r: JobRow): ScoringJob => ({
  title: r.title,
  company: r.company,
  location: r.location,
  workplace: r.workplace,
  seniority: r.seniority,
  salaryMin: r.salary_min,
  salaryMax: r.salary_max,
  salaryCurrency: r.salary_currency,
  salaryPeriod: r.salary_period,
  description: r.description,
});

function heuristicFor(r: JobRow): JobAnalysis {
  return heuristicAnalysis({
    title: r.title,
    description: r.description,
    workplace: r.workplace,
    salary:
      r.salary_min && r.salary_max
        ? { min: r.salary_min, max: r.salary_max, currency: r.salary_currency ?? "USD", period: (r.salary_period as "year") ?? "year" }
        : null,
  });
}

export function mergeAiAnalysis(h: JobAnalysis, ai: Omit<JobAnalysis, "salary" | "keywords">): JobAnalysis {
  const required = uniq(ai.requiredSkills.map(canonicalSkill));
  const nice = uniq(ai.niceToHaveSkills.map(canonicalSkill)).filter((s) => !required.includes(s));
  return {
    requiredSkills: required.length ? required : h.requiredSkills,
    niceToHaveSkills: nice.length ? nice : h.niceToHaveSkills,
    minYears: ai.minYears ?? h.minYears,
    seniority: ai.seniority ?? h.seniority,
    workplace: h.workplace ?? ai.workplace,
    // A deterministic "no sponsorship" regex hit is trusted over the model.
    visaSponsorship: h.visaSponsorship !== "unknown" ? h.visaSponsorship : ai.visaSponsorship,
    salary: h.salary,
    keywords: uniq([...required, ...nice, ...h.keywords]).slice(0, 30),
    summary: ai.summary,
  };
}

export function candidateSummary(resume: BaseResume, cand: CandidateIndex): string {
  return [
    resume.headline && `Headline: ${resume.headline}`,
    `Experience: ~${cand.years} years`,
    `Recent roles: ${resume.experience.slice(0, 4).map((e) => `${e.title} at ${e.company}`).join("; ")}`,
    `Skills: ${resume.skills.slice(0, 40).join(", ")}`,
    resume.summary && `Summary: ${resume.summary.slice(0, 500)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function analysisFor(env: Env, userId: string, r: JobRow, allowAi: boolean): Promise<{ analysis: JobAnalysis; ai: boolean; usedAi: boolean }> {
  if (r.a_json && r.a_hash === r.content_hash) {
    return { analysis: safeJson(r.a_json, heuristicFor(r)), ai: r.a_method === "ai", usedAi: false };
  }
  const h = heuristicFor(r);
  if (!allowAi) return { analysis: h, ai: false, usedAi: false };
  const res = await aiAnalyzeJob(env, userId, r);
  if (!res.ok) return { analysis: h, ai: false, usedAi: false };
  const merged = mergeAiAnalysis(h, res.data);
  await env.DB.prepare(
    `INSERT INTO job_analysis (job_id, content_hash, method, model, analysis_json, created_at) VALUES (?, ?, 'ai', ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET content_hash=excluded.content_hash, method='ai', model=excluded.model,
       analysis_json=excluded.analysis_json, created_at=excluded.created_at`,
  )
    .bind(r.id, r.content_hash, res.model, JSON.stringify(merged), now())
    .run();
  return { analysis: merged, ai: true, usedAi: !res.cached };
}

export const JOB_COLUMNS = `j.id, j.title, j.company, j.location, j.workplace, j.seniority, j.salary_min, j.salary_max,
  j.salary_currency, j.salary_period, j.description, j.content_hash, j.dedupe_key, j.updated_at,
  a.content_hash AS a_hash, a.method AS a_method, a.analysis_json AS a_json`;

export const JOB_SELECT = `SELECT ${JOB_COLUMNS} FROM jobs j LEFT JOIN job_analysis a ON a.job_id = j.id`;

export async function runMatching(
  env: Env,
  userId: string,
  opts: { full?: boolean; cursor?: MatchCursor | null } = {},
): Promise<MatchRunResult> {
  const result: MatchRunResult = { evaluated: 0, stored: 0, filtered: 0, aiAnalyses: 0, aiReasoned: 0, shortlisted: 0, more: false, cursor: null, embedded: 0 };
  const profile = await getProfile(env, userId);
  if (!profile.resume.skills.length && !profile.resume.experience.length) {
    return { ...result, skipped: "no-resume" };
  }
  const startWatermark = opts.full ? 0 : profile.matchWatermark;
  const cand = buildCandidate(profile.resume);
  const prefs = profile.preferences;
  const cursor = opts.cursor ?? null;

  // A run spans several queue messages (one per page). The first page takes a lease;
  // continuation pages (which carry a cursor) renew it; the last page releases it.
  const t0 = now();
  if (!cursor) {
    const lease = await env.DB.prepare("UPDATE profiles SET match_lease_until = ? WHERE user_id = ? AND match_lease_until < ?")
      .bind(t0 + LEASE_MS, userId, t0)
      .run();
    if (!lease.meta.changes) return { ...result, skipped: "locked" };
  } else {
    await env.DB.prepare("UPDATE profiles SET match_lease_until = ? WHERE user_id = ?").bind(t0 + LEASE_MS, userId).run();
  }

  if (opts.full && !cursor) {
    // Full re-match (resume or preferences changed): stale scores are recomputed below.
    await env.DB.prepare("DELETE FROM matches WHERE user_id = ? AND dismissed = 0").bind(userId).run();
  }

  const rows = await env.DB.prepare(
    `${JOB_SELECT}
     JOIN user_sources us ON us.source_id = j.source_id AND us.user_id = ?
     WHERE j.status = 'open' AND j.duplicate_of IS NULL AND j.updated_at > ?
       AND (j.updated_at > ? OR (j.updated_at = ? AND j.id > ?))
     ORDER BY j.updated_at ASC, j.id ASC LIMIT ${PAGE}`,
  )
    .bind(userId, startWatermark, cursor?.t ?? -1, cursor?.t ?? -1, cursor?.id ?? "")
    .all<JobRow>();
  result.evaluated = rows.results.length;
  result.more = rows.results.length === PAGE;
  const lastRow = rows.results.at(-1);
  result.cursor = lastRow ? { t: lastRow.updated_at, id: lastRow.id } : cursor;

  // Pass 1: deterministic hard filters (free).
  type Scored = { row: JobRow; analysis: JobAnalysis; ai: boolean; score: number; det: number; aiScore: number | null; reasons: MatchReasons };
  const survivors: { row: JobRow; analysis: JobAnalysis; ai: boolean }[] = [];
  const dropIds: string[] = [];
  for (const row of rows.results) {
    const { analysis, ai } = await analysisFor(env, userId, row, false);
    if (hardFilter(toScoringJob(row), analysis, prefs, profile.personal, cand)) {
      result.filtered++;
      dropIds.push(row.id);
      continue;
    }
    survivors.push({ row, analysis, ai });
  }

  // Semantic similarity for survivors (cached embeddings; budget-gated, optional).
  const resumeVec = survivors.length ? await resumeVector(env, userId, profile.resume, profile.resumeVersion) : null;
  const { vectors, embedded } = resumeVec ? await jobVectors(env, userId, survivors.map((s) => s.row)) : { vectors: new Map<string, number[]>(), embedded: 0 };
  result.embedded = embedded;
  const ctxFor = (jobId: string): ScoreContext => {
    const v = vectors.get(jobId);
    return {
      requiresSponsorship: profile.personal.requiresSponsorship,
      country: profile.personal.country,
      semantic: resumeVec && v ? semanticFit(cosine(resumeVec, v)) : null,
    };
  };

  // Pass 2: weighted score.
  const kept: Scored[] = [];
  for (const { row, analysis, ai } of survivors) {
    const { score, reasons } = scoreJob(toScoringJob(row), analysis, cand, prefs, ctxFor(row.id));
    if (score < prefs.minScore - 10) {
      dropIds.push(row.id);
      continue;
    }
    kept.push({ row, analysis, ai, score, det: score, aiScore: null, reasons: { ...reasons, analysis: ai ? "ai" : "heuristic" } });
  }

  // Pass 2: AI JD analysis for the most promising jobs only (cached + shared across users).
  const settings = profile.settings;
  if (await aiAllowed(env, userId, "jd_analysis", settings)) {
    const candidates = kept
      .filter((k) => !k.ai && k.det >= Math.max(prefs.minScore, AMBIGUOUS_LOW))
      .sort((a, b) => b.det - a.det)
      .slice(0, MAX_AI_ANALYSES_PER_RUN);
    for (const k of candidates) {
      const res = await analysisFor(env, userId, { ...k.row, a_json: null }, true);
      if (!res.ai) continue;
      if (res.usedAi) result.aiAnalyses++;
      const job = toScoringJob(k.row);
      if (hardFilter(job, res.analysis, prefs, profile.personal, cand)) {
        k.score = -1; // newly revealed hard blocker (e.g. no sponsorship)
        continue;
      }
      const s = scoreJob(job, res.analysis, cand, prefs, ctxFor(k.row.id));
      Object.assign(k, { analysis: res.analysis, ai: true, score: s.score, det: s.score, reasons: { ...s.reasons, analysis: "ai" } });
    }
  }

  // Pass 3: AI reasoning only where the deterministic score is ambiguous.
  if (await aiAllowed(env, userId, "match_reasoning", settings)) {
    const ambiguous = kept
      .filter((k) => k.ai && k.det >= AMBIGUOUS_LOW && k.det <= AMBIGUOUS_HIGH)
      .sort((a, b) => b.det - a.det)
      .slice(0, MAX_AI_REASONING_PER_RUN);
    const summary = candidateSummary(profile.resume, cand);
    for (const k of ambiguous) {
      const res = await aiMatchReasoning(env, userId, summary, { title: k.row.title, company: k.row.company, analysis: k.analysis });
      if (!res.ok) break; // budget or model failure: keep deterministic scores
      if (!res.cached) result.aiReasoned++;
      k.aiScore = res.data.score;
      k.score = Math.round(0.5 * k.det + 0.5 * res.data.score);
      k.reasons = { ...k.reasons, rationale: res.data.rationale, concerns: res.data.concerns };
    }
  }

  const t = now();
  const stmts: D1PreparedStatement[] = [];
  const toStore = kept.filter((k) => k.score >= prefs.minScore);
  for (const k of kept) if (k.score < prefs.minScore) dropIds.push(k.row.id);
  for (const k of toStore) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO matches (user_id, job_id, score, det_score, ai_score, reasons_json, resume_version, job_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, job_id) DO UPDATE SET score=excluded.score, det_score=excluded.det_score,
           ai_score=excluded.ai_score, reasons_json=excluded.reasons_json, resume_version=excluded.resume_version,
           job_hash=excluded.job_hash, updated_at=excluded.updated_at`,
      ).bind(userId, k.row.id, k.score, k.det, k.aiScore, JSON.stringify(k.reasons), profile.resumeVersion, k.row.content_hash, t, t),
    );
  }
  if (startWatermark > 0 || cursor) {
    for (const ids of chunk(dropIds, 80)) {
      stmts.push(
        env.DB.prepare(`DELETE FROM matches WHERE user_id = ? AND dismissed = 0 AND job_id IN (${ids.map(() => "?").join(",")})`).bind(userId, ...ids),
      );
    }
  }
  for (const batch of chunk(stmts, 50)) await env.DB.batch(batch);
  result.stored = toStore.length;

  // Automation: shortlist strong matches (and optionally prepare them).
  if (settings.autoShortlistScore > 0) {
    const strong = toStore.filter((x) => x.score >= settings.autoShortlistScore).sort((a, b) => b.score - a.score);
    if (settings.autoPrepare) {
      // Auto mode: only create applications for the few that will actually be prepared today,
      // so the review list stays short. Capped per day via a synchronously written marker event
      // (workflow status events land later, so counting those would let pages overshoot).
      const dayStart = new Date().setUTCHours(0, 0, 0, 0);
      const today = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM application_events WHERE user_id = ? AND type = 'info' AND message = 'Auto-prepare started' AND created_at >= ?",
      )
        .bind(userId, dayStart)
        .first<{ n: number }>();
      let room = Math.max(0, settings.autoPrepareDailyLimit - (today?.n ?? 0));
      const picked: string[] = [];
      for (const k of strong) {
        if (room <= 0) break;
        const id = await createApplication(env, userId, k.row.id, k.row.dedupe_key, `Auto-selected (score ${k.score})`);
        if (!id) continue;
        picked.push(id);
        room--;
      }
      if (picked.length) {
        await env.DB.batch(picked.map((id) => eventStmt(env, id, userId, "info", "Auto-prepare started")));
        await env.PREPARE_WORKFLOW.createBatch(picked.map((id) => ({ id: `prep-${id}-auto`, params: { applicationId: id, userId } })));
      }
      result.shortlisted = picked.length;
    } else {
      for (const k of strong) if (await createApplication(env, userId, k.row.id, k.row.dedupe_key, `Auto-shortlisted (score ${k.score})`)) result.shortlisted++;
    }
  }

  // Advance the watermark and release the lease only once every page has been processed.
  if (!result.more) {
    if (result.cursor) await setWatermark(env, userId, profile.matchWatermark, result.cursor.t);
    await env.DB.prepare("UPDATE profiles SET match_lease_until = 0 WHERE user_id = ?").bind(userId).run();
  }
  return result;
}
