import type { FormField, PreparedAnswer, TailoredResume } from "../../shared/types";
import type { ApplicationRow } from "../db/applications";
import { getProfile } from "../db/profile";
import type { Env } from "../env";
import { decryptJson, keyring } from "../lib/crypto";
import { getPrivateJson } from "../lib/storage";
import { safeJson } from "../lib/util";
import { buildReport, checkAnswers, checkResume, type QualityCheck, type QualityReport } from "./quality";

export interface StoredQuality {
  resume: QualityCheck[];
  answers: QualityCheck[];
  report: QualityReport;
}

/**
 * Recompute and store an application's quality report. The resume audit is reused unless
 * `withResume` (it only changes when the tailored resume changes).
 */
export async function refreshQuality(env: Env, app: ApplicationRow, opts: { withResume?: boolean; answers?: PreparedAnswer[]; company?: string } = {}): Promise<StoredQuality> {
  const prev = safeJson<StoredQuality | null>(app.quality_json, null);
  const profile = await getProfile(env, app.user_id);
  let resumeChecks = prev?.resume ?? [];
  if (opts.withResume || !prev) {
    const tailored = app.tailored_key ? await getPrivateJson<TailoredResume>(env, app.tailored_key) : null;
    resumeChecks = checkResume(profile.resume, tailored, { email: profile.personal.email, phone: profile.personal.phone });
  }
  const answers = opts.answers ?? (await decryptJson<PreparedAnswer[]>(keyring(env), app.answers_enc, []));
  const fields = safeJson<FormField[]>(app.form_json, []);
  const company =
    opts.company ??
    (await env.DB.prepare("SELECT company FROM jobs WHERE id = ?").bind(app.job_id).first<{ company: string }>())?.company ??
    "";
  const answerChecks = answers.length ? checkAnswers(fields, answers, { resume: profile.resume, company }) : [];
  const stored: StoredQuality = { resume: resumeChecks, answers: answerChecks, report: buildReport([...resumeChecks, ...answerChecks]) };
  await env.DB.prepare("UPDATE applications SET quality_json = ? WHERE id = ?").bind(JSON.stringify(stored), app.id).run();
  return stored;
}
