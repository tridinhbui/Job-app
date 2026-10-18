import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { PreparedAnswer } from "../../shared/types";
import { ADAPTERS, adapterById } from "../apply/adapters";
import { getApplication, logEvent, transition } from "../db/applications";
import { getProfile } from "../db/profile";
import type { Env, SubmitParams } from "../env";
import { decryptJson, keyring } from "../lib/crypto";
import { getPrivate, putPrivate, userKey } from "../lib/storage";
import { logRun } from "../lib/runs";
import { errorMessage, now, truncate } from "../lib/util";

// Submit = fill the real form in a browser and (live mode only) click submit, then verify.
// Safety layers: user approval (status 'approved'), global SUBMIT_MODE, per-user live toggle,
// duplicate detection, and a clicked_at compare-and-set so a retried step never clicks twice.

/** Boards with a browser adapter that may click submit (others use assisted apply). */
export const SUBMIT_ADAPTERS = new Set(ADAPTERS.filter((a) => a.mode === "automated").map((a) => a.id as string));

/**
 * Why a live submission must not happen, or null. A role is "taken" once any application for
 * it (same dedupe key) clicked submit, was submitted, or was marked applied by the user.
 */
export async function duplicateReason(
  env: Env,
  app: { id: string; user_id: string; dedupe_key: string; clicked_at: number | null; submitted_at: number | null },
  confirmNotSubmitted: boolean,
): Promise<string | null> {
  if (app.submitted_at) return "Duplicate: this application was already submitted";
  const lock = await env.DB.prepare("SELECT application_id FROM submission_locks WHERE user_id = ? AND dedupe_key = ?")
    .bind(app.user_id, app.dedupe_key)
    .first<{ application_id: string }>();
  if (lock && lock.application_id !== app.id) return "Duplicate: you already applied to this role (another posting)";
  const applied = await env.DB.prepare(
    "SELECT id FROM applications WHERE user_id = ? AND dedupe_key = ? AND id != ? AND (submitted_at IS NOT NULL OR status IN ('submitted','interview','offered')) LIMIT 1",
  )
    .bind(app.user_id, app.dedupe_key, app.id)
    .first();
  if (applied) return "Duplicate: you already applied to this role";
  if (lock || app.clicked_at) {
    if (!confirmNotSubmitted) return "An earlier attempt clicked submit but could not be verified. Check your email; retry only if you confirm it did not go through.";
    // The user verified with the employer that the earlier attempt failed.
    await releaseSubmitLock(env, app.user_id, app.id);
    await env.DB.prepare("UPDATE applications SET clicked_at = NULL WHERE id = ?").bind(app.id).run();
  }
  return null;
}

/** Called right before the click. Atomic: wins only if no click was ever recorded for this role. */
export async function acquireSubmitLock(env: Env, userId: string, applicationId: string, dedupeKey: string): Promise<boolean> {
  const t = now();
  const [lock, mark] = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO submission_locks (user_id, dedupe_key, application_id, locked_at) VALUES (?, ?, ?, ?)").bind(userId, dedupeKey, applicationId, t),
    env.DB.prepare("UPDATE applications SET clicked_at = ? WHERE id = ? AND clicked_at IS NULL").bind(t, applicationId),
  ]);
  return lock!.meta.changes === 1 && mark!.meta.changes === 1;
}

export async function releaseSubmitLock(env: Env, userId: string, applicationId: string) {
  await env.DB.prepare("DELETE FROM submission_locks WHERE user_id = ? AND application_id = ?").bind(userId, applicationId).run();
}

export function effectiveMode(env: Env, requested: "dry_run" | "live", liveEnabled: boolean, adapter?: string | null): "dry_run" | "live" {
  // The local fixture form (dev only) may be submitted live: it is not a real employer.
  if (adapter === "fixture" && env.AUTH_MODE === "dev") return requested;
  return requested === "live" && env.SUBMIT_MODE === "live" && liveEnabled ? "live" : "dry_run";
}

export class SubmitApplicationWorkflow extends WorkflowEntrypoint<Env, SubmitParams> {
  async run(event: WorkflowEvent<SubmitParams>, step: WorkflowStep) {
    const { applicationId, userId } = event.payload;
    const env = this.env;

    const guard = await step.do("guard", async () => {
      const app = await getApplication(env, userId, applicationId);
      const profile = await getProfile(env, userId);
      const mode = effectiveMode(env, event.payload.mode, profile.settings.liveSubmitEnabled, app.adapter);
      if (app.status === "submitting") return { ok: true, mode: (app.submit_mode as "dry_run" | "live") ?? mode, reason: "" };
      if (app.status !== "approved") return { ok: false, mode, reason: `Application is ${app.status}, not approved` };
      if (!SUBMIT_ADAPTERS.has(app.adapter ?? "")) return { ok: false, mode, reason: "No automation adapter for this job board" };

      const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(app.job_id).first<{ status: string }>();
      if (job?.status !== "open") {
        await transition(env, app, ["approved"], "prepared", "Job posting is closed; submission cancelled");
        return { ok: false, mode, reason: "Job is closed" };
      }
      if (mode === "live") {
        const reason = await duplicateReason(env, app, !!event.payload.confirmNotSubmitted);
        if (reason) {
          await transition(env, app, ["approved"], "prepared", reason);
          return { ok: false, mode, reason };
        }
      }
      const ok = await transition(env, app, ["approved"], "submitting", mode === "live" ? "Submitting (live)" : "Dry run started", {
        submit_mode: mode,
        submit_attempts: app.submit_attempts + 1,
        error: null,
      });
      return { ok, mode, reason: ok ? "" : "Concurrent update" };
    });
    if (!guard.ok) return { skipped: guard.reason };

    let run: {
      outcome: string;
      message: string;
      confirmation: string | null;
      screenshotKey: string | null;
      filled?: number;
      failedFields?: string[];
      blockedWrites?: number;
    };
    try {
      run = await step.do(
        "browser",
        // One retry for infrastructure failures. A retry after a click is safe: beforeClick()
        // refuses a second click and the outcome becomes "unverified".
        { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "5 minutes" },
        async () => {
          const app = await getApplication(env, userId, applicationId);
          const profile = await getProfile(env, userId);
          const job = await env.DB.prepare("SELECT apply_url, company, title FROM jobs WHERE id = ?")
            .bind(app.job_id)
            .first<{ apply_url: string; company: string; title: string }>();
          if (!job) throw new Error("Job not found");
          const answers = await decryptJson<PreparedAnswer[]>(keyring(env), app.answers_enc, []);
          const pdf = app.resume_pdf_key ? await getPrivate(env, app.resume_pdf_key) : null;
          if (!pdf) throw new Error("Tailored resume PDF is missing; re-run preparation");
          const name = `${profile.personal.firstName}_${profile.personal.lastName}_Resume.pdf`.replace(/[^\w.-]/g, "_");

          const runner = adapterById(app.adapter).run;
          if (!runner) throw new Error(`No browser adapter for ${app.adapter}`);
          const res = await runner(env, {
            applyUrl: job.apply_url,
            answers,
            resume: { name, bytes: pdf.bytes },
            phoneCountry: profile.personal.phoneCountry || profile.personal.country,
            mode: guard.mode,
            beforeClick: () => acquireSubmitLock(env, userId, applicationId, app.dedupe_key),
          });
          if (res.outcome === "error") throw new Error(res.message); // retry once
          let screenshotKey: string | null = null;
          if (res.screenshot) {
            screenshotKey = userKey(userId, `screenshots/${applicationId}-${Date.now()}.jpg`);
            await putPrivate(env, screenshotKey, res.screenshot, "image/jpeg");
          }
          const failedNote = res.failed.length ? ` Unfilled: ${res.failed.map((f) => `${f.label} (${f.reason})`).join("; ")}` : "";
          return {
            outcome: res.outcome,
            message: truncate(res.message + failedNote, 900),
            confirmation: res.confirmation,
            screenshotKey,
            filled: res.filled.length,
            failedFields: res.failed.map((f) => f.label.slice(0, 80)).slice(0, 20),
            blockedWrites: res.blockedWrites,
          };
        },
      );
    } catch (e) {
      run = { outcome: "error", message: truncate(errorMessage(e), 500), confirmation: null, screenshotKey: null };
    }

    await step.do("record", async () => {
      const app = await getApplication(env, userId, applicationId);
      const shot = { screenshot_key: run.screenshotKey ?? app.screenshot_key };
      switch (run.outcome) {
        case "submitted":
          await transition(env, app, ["submitting"], "submitted", run.message, {
            ...shot,
            submitted_at: now(),
            confirmation_text: run.confirmation,
          });
          break;
        case "dry_run_ok":
          // Never touch clicked_at here: an earlier live attempt's click must stay recorded.
          await transition(env, app, ["submitting"], "prepared", run.message, { ...shot, error: null });
          break;
        case "validation_failed":
          // The site visibly rejected the form, so nothing was submitted: release the lock and
          // allow a corrected retry.
          await releaseSubmitLock(env, userId, applicationId);
          await transition(env, app, ["submitting"], "prepared", run.message, { ...shot, clicked_at: null, error: run.message });
          break;
        case "blocked":
        case "unverified":
          await transition(env, app, ["submitting"], "needs_manual", run.message, { ...shot, error: run.message });
          break;
        default:
          await transition(env, app, ["submitting"], app.clicked_at ? "needs_manual" : "failed", `Submission error: ${run.message}`, {
            ...shot,
            error: run.message,
          });
      }
      if (guard.mode === "dry_run") await logEvent(env, app.id, userId, "info", "Dry-run mode: the submit button was not clicked.");
      await logRun(env, {
        kind: "submit",
        status: run.outcome,
        userId,
        refId: applicationId,
        startedAt: event.timestamp.getTime(),
        metrics: { mode: guard.mode, adapter: app.adapter, filled: run.filled ?? 0, failed: run.failedFields?.length ?? 0, failedFields: run.failedFields ?? [], blockedWrites: run.blockedWrites ?? 0 },
        error: run.outcome === "submitted" || run.outcome === "dry_run_ok" ? null : run.message,
      });
    });
    return { outcome: run.outcome };
  }
}
