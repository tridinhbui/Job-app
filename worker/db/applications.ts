import type { AppStatus } from "../../shared/types";
import type { Env } from "../env";
import { HttpError, now, uuid } from "../lib/util";

// Allowed manual/automatic status transitions. Anything else is rejected, which keeps
// workflows idempotent (a retried step cannot move an application backwards).
const TRANSITIONS: Record<AppStatus, AppStatus[]> = {
  shortlisted: ["preparing", "withdrawn", "submitted"],
  preparing: ["prepared", "failed", "shortlisted"],
  prepared: ["preparing", "approved", "withdrawn", "submitted", "needs_manual"],
  approved: ["submitting", "prepared", "withdrawn"],
  submitting: ["submitted", "needs_manual", "failed", "prepared"],
  needs_manual: ["submitted", "preparing", "prepared", "withdrawn"],
  failed: ["preparing", "prepared", "withdrawn", "submitted"],
  submitted: ["interview", "rejected", "offered", "withdrawn"],
  interview: ["offered", "rejected", "withdrawn", "interview"],
  offered: ["withdrawn", "rejected"],
  rejected: ["interview"],
  withdrawn: ["shortlisted"],
};

export function canTransition(from: AppStatus, to: AppStatus) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface ApplicationRow {
  id: string;
  user_id: string;
  job_id: string;
  status: AppStatus;
  dedupe_key: string;
  adapter: string | null;
  tailored_key: string | null;
  resume_pdf_key: string | null;
  tailor_method: string | null;
  answers_enc: string | null;
  form_json: string | null;
  missing_json: string | null;
  workflow_id: string | null;
  submit_mode: string | null;
  submit_attempts: number;
  clicked_at: number | null;
  submitted_at: number | null;
  screenshot_key: string | null;
  confirmation_text: string | null;
  error: string | null;
  notes: string | null;
  quality_json: string | null;
  created_at: number;
  updated_at: number;
}

export async function getApplication(env: Env, userId: string, id: string): Promise<ApplicationRow> {
  const row = await env.DB.prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?").bind(id, userId).first<ApplicationRow>();
  if (!row) throw new HttpError(404, "Application not found");
  return row;
}

export function eventStmt(
  env: Env,
  appId: string,
  userId: string,
  type: "status" | "note" | "error" | "info",
  message: string | null,
  from?: AppStatus | null,
  to?: AppStatus | null,
) {
  return env.DB.prepare(
    "INSERT INTO application_events (application_id, user_id, type, from_status, to_status, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(appId, userId, type, from ?? null, to ?? null, message, now());
}

/** Creates a shortlisted application unless one exists for this job (or a duplicate posting). */
export async function createApplication(env: Env, userId: string, jobId: string, dedupeKey: string, note: string): Promise<string | null> {
  const dupe = await env.DB.prepare("SELECT id FROM applications WHERE user_id = ? AND (job_id = ? OR dedupe_key = ?) LIMIT 1")
    .bind(userId, jobId, dedupeKey)
    .first<{ id: string }>();
  if (dupe) return null;
  const id = uuid();
  const t = now();
  const res = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO applications (id, user_id, job_id, status, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, 'shortlisted', ?, ?, ?)",
    ).bind(id, userId, jobId, dedupeKey, t, t),
    eventStmt(env, id, userId, "status", note, null, "shortlisted"),
  ]);
  return res[0]?.meta.changes ? id : null;
}

/**
 * Atomic compare-and-set status change. Returns false (and writes nothing) if the
 * application is no longer in one of the expected states.
 */
export async function transition(
  env: Env,
  app: Pick<ApplicationRow, "id" | "user_id">,
  from: AppStatus[],
  to: AppStatus,
  message: string | null,
  extra: Record<string, string | number | null> = {},
): Promise<boolean> {
  const cols = Object.keys(extra);
  const sets = ["status = ?", "updated_at = ?", ...cols.map((c) => `${c} = ?`)].join(", ");
  const res = await env.DB.prepare(
    `UPDATE applications SET ${sets} WHERE id = ? AND user_id = ? AND status IN (${from.map(() => "?").join(",")})`,
  )
    .bind(to, now(), ...cols.map((c) => extra[c] ?? null), app.id, app.user_id, ...from)
    .run();
  if (!res.meta.changes) return false;
  await eventStmt(env, app.id, app.user_id, "status", message, from.length === 1 ? from[0] : null, to).run();
  return true;
}

export async function logEvent(env: Env, appId: string, userId: string, type: "note" | "error" | "info", message: string) {
  await eventStmt(env, appId, userId, type, message).run();
}
