import type { Env } from "../env";
import { errorMessage, now, truncate } from "./util";

// Operational run log for monitoring. One small insert per unit of work; never throws (logging
// must not break the work it describes).

export type RunKind = "crawl" | "match" | "prepare" | "submit" | "digest" | "health";

export async function logRun(
  env: Env,
  run: { kind: RunKind; status: string; userId?: string | null; refId?: string | null; startedAt?: number; metrics?: Record<string, unknown>; error?: unknown },
) {
  try {
    await env.DB.prepare("INSERT INTO runs (kind, status, user_id, ref_id, duration_ms, metrics_json, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(
        run.kind,
        run.status,
        run.userId ?? null,
        run.refId ?? null,
        run.startedAt ? now() - run.startedAt : null,
        run.metrics ? JSON.stringify(run.metrics) : null,
        run.error == null ? null : truncate(typeof run.error === "string" ? run.error : errorMessage(run.error), 500),
        now(),
      )
      .run();
  } catch (e) {
    console.error(JSON.stringify({ event: "run_log_failed", kind: run.kind, error: errorMessage(e) }));
  }
}
