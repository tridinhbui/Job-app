import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { FormField, JobAnalysis, PreparedAnswer, TailoredResume } from "../../shared/types";
import { aiAllowed } from "../ai/client";
import { aiAnswerQuestions, aiTailorResume } from "../ai/tasks";
import { chooseOption, missingRequired, prepareDeterministicAnswers } from "../apply/answers";
import { fetchGreenhouseForm, parseGreenhouseUrl } from "../apply/greenhouse-form";
import { getApplication, logEvent, transition } from "../db/applications";
import { getProfile } from "../db/profile";
import type { Env, PrepareParams } from "../env";
import { encryptJson } from "../lib/crypto";
import { putPrivate, userKey } from "../lib/storage";
import { errorMessage, now, truncate } from "../lib/util";
import { analysisFor, candidateSummary, JOB_COLUMNS } from "../matching/run";
import { buildCandidate } from "../matching/score";
import { renderResumePdf } from "../resume/pdf";
import { guardAiTailoring, tailorDeterministic } from "../resume/tailor";

// Prepare = tailor resume + read the application form + draft answers. Never submits.
// Each step is idempotent and cached, so retries and re-runs do not repeat paid work.

type JobRowForPrep = Parameters<typeof analysisFor>[2] & { apply_url: string; job_url: string; source_id: string };

export function adapterFor(applyUrl: string): "greenhouse" | "manual" {
  try {
    const host = new URL(applyUrl).hostname;
    return /(^|\.)greenhouse\.io$/.test(host) && parseGreenhouseUrl(applyUrl) ? "greenhouse" : "manual";
  } catch {
    return "manual";
  }
}

const JOB_SELECT_PREP = `SELECT ${JOB_COLUMNS}, j.apply_url, j.job_url, j.source_id
  FROM jobs j LEFT JOIN job_analysis a ON a.job_id = j.id`;

async function loadJob(env: Env, jobId: string): Promise<JobRowForPrep> {
  const job = await env.DB.prepare(`${JOB_SELECT_PREP} WHERE j.id = ?`)
    .bind(jobId)
    .first<JobRowForPrep>();
  if (!job) throw new Error("Job not found");
  return job;
}

export class PrepareApplicationWorkflow extends WorkflowEntrypoint<Env, PrepareParams> {
  async run(event: WorkflowEvent<PrepareParams>, step: WorkflowStep) {
    const { applicationId, userId } = event.payload;
    const env = this.env;
    try {
      const start = await step.do("start", async () => {
        const app = await getApplication(env, userId, applicationId);
        if (app.status !== "preparing") {
          const ok = await transition(env, app, ["shortlisted", "prepared", "failed", "needs_manual"], "preparing", "Preparation started");
          if (!ok) return { skip: true, jobId: app.job_id };
        }
        return { skip: false, jobId: app.job_id };
      });
      if (start.skip) return { skipped: true };

      const analysis = await step.do("analyze-job", async () => {
        const job = await loadJob(env, start.jobId);
        const allowAi = await aiAllowed(env, userId, "jd_analysis");
        return (await analysisFor(env, userId, job, allowAi)).analysis;
      });

      const tailored = await step.do("tailor-resume", { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "3 minutes" }, async () =>
        this.tailor(userId, start.jobId, analysis),
      );

      const form = await step.do("prepare-answers", { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "3 minutes" }, async () =>
        this.answers(userId, applicationId, start.jobId, analysis),
      );

      await step.do("finish", async () => {
        const app = await getApplication(env, userId, applicationId);
        await transition(env, app, ["preparing"], "prepared", summaryMessage(tailored, form), {
          tailored_key: tailored.jsonKey,
          resume_pdf_key: tailored.pdfKey,
          tailor_method: tailored.method,
          adapter: form.adapter,
          error: form.missing.length ? `Needs your input: ${truncate(form.missing.join("; "), 400)}` : null,
        });
      });
      return { ok: true };
    } catch (e) {
      await step.do("mark-failed", async () => {
        const app = await getApplication(env, userId, applicationId);
        await transition(env, app, ["preparing"], "failed", `Preparation failed: ${truncate(errorMessage(e), 300)}`, {
          error: truncate(errorMessage(e), 500),
        });
      });
      throw e;
    }
  }

  private async tailor(userId: string, jobId: string, analysis: JobAnalysis) {
    const env = this.env;
    const profile = await getProfile(env, userId);
    const job = await loadJob(env, jobId);
    const cached = await env.DB.prepare(
      "SELECT method, json_key, pdf_key FROM tailored_resumes WHERE user_id = ? AND job_id = ? AND resume_version = ? AND job_hash = ?",
    )
      .bind(userId, jobId, profile.resumeVersion, job.content_hash)
      .first<{ method: "ai" | "deterministic"; json_key: string; pdf_key: string }>();
    if (cached) return { jsonKey: cached.json_key, pdfKey: cached.pdf_key, method: cached.method, changes: ["Reused cached tailored resume"], note: null as string | null };

    const keywords = analysis.keywords.length ? analysis.keywords : [...analysis.requiredSkills, ...analysis.niceToHaveSkills];
    const deterministic = tailorDeterministic(profile.resume, jobId, keywords);
    let result: TailoredResume = deterministic;
    let note: string | null = null;
    if (profile.resume.experience.length) {
      const ai = await aiTailorResume(env, userId, profile.resume, {
        title: job.title,
        company: job.company,
        keywords,
        description: job.description,
      });
      if (ai.ok) result = guardAiTailoring(profile.resume, ai.data, deterministic);
      else note = ai.message;
    }

    const pdf = await renderResumePdf(result, profile.personal, `${job.title} at ${job.company}`);
    const base = `tailored/${jobId}/v${profile.resumeVersion}-${job.content_hash}`;
    const jsonKey = userKey(userId, `${base}.json`);
    const pdfKey = userKey(userId, `${base}.pdf`);
    await putPrivate(env, jsonKey, JSON.stringify(result), "application/json");
    await putPrivate(env, pdfKey, pdf, "application/pdf");
    await env.DB.prepare(
      `INSERT OR REPLACE INTO tailored_resumes (user_id, job_id, resume_version, job_hash, method, json_key, pdf_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(userId, jobId, profile.resumeVersion, job.content_hash, result.method, jsonKey, pdfKey, now())
      .run();
    return { jsonKey, pdfKey, method: result.method, changes: result.changes, note };
  }

  private async answers(userId: string, applicationId: string, jobId: string, analysis: JobAnalysis) {
    const env = this.env;
    const job = await loadJob(env, jobId);
    const adapter = adapterFor(job.apply_url);
    if (adapter === "manual") {
      await env.DB.prepare("UPDATE applications SET form_json = NULL, answers_enc = NULL, missing_json = '[]' WHERE id = ?").bind(applicationId).run();
      return { adapter, fields: 0, aiAnswered: 0, missing: [] as string[], note: "This board has no automation adapter yet — apply manually with the tailored resume." };
    }

    const gh = parseGreenhouseUrl(job.apply_url)!;
    const fields: FormField[] = await fetchGreenhouseForm(gh.board, gh.jobId);
    const profile = await getProfile(env, userId);
    const { answers, needsAi } = prepareDeterministicAnswers(fields, {
      personal: profile.personal,
      resume: profile.resume,
      library: profile.answers,
      job: { company: job.company, title: job.title, location: job.location },
    });

    let aiAnswered = 0;
    let note: string | null = null;
    if (needsAi.length) {
      const res = await aiAnswerQuestions(env, userId, needsAi.slice(0, 12), {
        candidate: `${candidateSummary(profile.resume, buildCandidate(profile.resume))}\nLocation: ${[profile.personal.city, profile.personal.country].filter(Boolean).join(", ")}`,
        job: `${job.title} at ${job.company} (${job.location ?? "n/a"})\n${analysis.summary}\n${truncate(job.description, 2500)}`,
      });
      if (res.ok) {
        for (const r of res.data.answers) {
          const field = needsAi.find((f) => f.key === r.key);
          const target = answers.find((a) => a.key === r.key);
          if (!field || !target || !r.confident || !r.answer.trim()) continue;
          const value = field.options.length ? chooseOption(field.options, r.answer) : r.answer.trim();
          if (!value) continue;
          Object.assign(target, { value, source: "ai", needsReview: true, note: "AI draft — review before approving" } satisfies Partial<PreparedAnswer>);
          aiAnswered++;
        }
      } else note = res.message;
    }

    const missing = missingRequired(answers);
    await env.DB.prepare("UPDATE applications SET form_json = ?, answers_enc = ?, missing_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(fields), await encryptJson(env.DATA_ENCRYPTION_KEY, answers), JSON.stringify(missing), now(), applicationId)
      .run();
    if (note) await logEvent(env, applicationId, userId, "info", `AI answers skipped: ${note}`);
    return { adapter, fields: fields.length, aiAnswered, missing, note };
  }
}

function summaryMessage(
  t: { method: string; changes: string[]; note: string | null },
  f: { adapter: string; fields: number; aiAnswered: number; missing: string[]; note: string | null },
) {
  const parts = [`Resume tailored (${t.method}).`];
  if (t.note) parts.push(`AI tailoring unavailable: ${t.note}.`);
  if (f.adapter === "greenhouse") {
    parts.push(`${f.fields} form field(s) read; ${f.aiAnswered} drafted by AI.`);
    if (f.missing.length) parts.push(`${f.missing.length} required field(s) need your input.`);
  } else parts.push(f.note ?? "Manual application.");
  return parts.join(" ");
}
