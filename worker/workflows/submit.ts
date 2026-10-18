import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { PreparedAnswer } from "../../shared/types";
import { ADAPTERS, adapterById } from "../apply/adapters";
import { getApplication, logEvent, transition } from "../db/applications";
import { getProfile } from "../db/profile";
import type { Env, SubmitParams } from "../env";
import { decryptJson, keyring } from "../lib/crypto";
import { getPrivate, putPrivate, userKey } from "../lib/storage";
import { errorMessage, now, truncate } from "../lib/util";

// Submit = fill the real form in a browser and (live mode only) click submit, then verify.
// Safety layers: user approval (status 'approved'), global SUBMIT_MODE, per-user live toggle,
// duplicate detection, and a clicked_at compare-and-set so a retried step never clicks twice.

/** Boards with a browser adapter that may click submit (others use assisted apply). */
export const SUBMIT_ADAPTERS = new Set(ADAPTERS.filter((a) => a.mode === "automated").map((a) => a.id as string));

export function effectiveMode(env: Env, requested: "dry_run" | "live", liveEnabled: boolean): "dry_run" | "live" {
  return requested === "live" && env.SUBMIT_MODE === "live" && liveEnabled ? "live" : "dry_run";
}

export class SubmitApplicationWorkflow extends WorkflowEntrypoint<Env, SubmitParams> {
  async run(event: WorkflowEvent<SubmitParams>, step: WorkflowStep) {
    const { applicationId, userId } = event.payload;
    const env = this.env;

    const guard = await step.do("guard", async () => {
      const app = await getApplication(env, userId, applicationId);
      const profile = await getProfile(env, userId);
      const mode = effectiveMode(env, event.payload.mode, profile.settings.liveSubmitEnabled);
      if (app.status === "submitting") return { ok: true, mode: (app.submit_mode as "dry_run" | "live") ?? mode, reason: "" };
      if (app.status !== "approved") return { ok: false, mode, reason: `Application is ${app.status}, not approved` };
      if (!SUBMIT_ADAPTERS.has(app.adapter ?? "")) return { ok: false, mode, reason: "No automation adapter for this job board" };

      const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(app.job_id).first<{ status: string }>();
      if (job?.status !== "open") {
        await transition(env, app, ["approved"], "prepared", "Job posting is closed; submission cancelled");
        return { ok: false, mode, reason: "Job is closed" };
      }
      if (mode === "live") {
        const dup = await env.DB.prepare(
          "SELECT id FROM applications WHERE user_id = ? AND dedupe_key = ? AND id != ? AND (submitted_at IS NOT NULL OR status IN ('submitted','interview','offered')) LIMIT 1",
        )
          .bind(userId, app.dedupe_key, app.id)
          .first();
        if (dup || app.submitted_at) {
          await transition(env, app, ["approved"], "prepared", "Duplicate: you already applied to this role");
          return { ok: false, mode, reason: "Duplicate application" };
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

    let run: { outcome: string; message: string; confirmation: string | null; screenshotKey: string | null };
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
            beforeClick: async () => {
              const r = await env.DB.prepare("UPDATE applications SET clicked_at = ? WHERE id = ? AND clicked_at IS NULL").bind(now(), applicationId).run();
              return r.meta.changes === 1;
            },
          });
          if (res.outcome === "error") throw new Error(res.message); // retry once
          let screenshotKey: string | null = null;
          if (res.screenshot) {
            screenshotKey = userKey(userId, `screenshots/${applicationId}-${Date.now()}.jpg`);
            await putPrivate(env, screenshotKey, res.screenshot, "image/jpeg");
          }
          const failedNote = res.failed.length ? ` Unfilled: ${res.failed.map((f) => `${f.label} (${f.reason})`).join("; ")}` : "";
          return { outcome: res.outcome, message: truncate(res.message + failedNote, 900), confirmation: res.confirmation, screenshotKey };
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
          await transition(env, app, ["submitting"], "prepared", run.message, { ...shot, clicked_at: null, error: null });
          break;
        case "validation_failed":
          // Nothing was accepted by the site; allow a corrected retry.
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
    });
    return { outcome: run.outcome };
  }
}
