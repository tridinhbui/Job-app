import { crawlSource } from "./discovery/crawl";
import { SourceError } from "./discovery/types";
import type { Env, QueueMessage } from "./env";
import { chunk, errorMessage, now } from "./lib/util";
import { runMatching } from "./matching/run";
import { sendDueDigests } from "./email/digest";
import { reencryptBatch } from "./lib/rotate";
import { logRun } from "./lib/runs";
import { probeAdapters } from "./apply/health";

// Background processing: cron enqueues small, independent messages; the queue consumer
// processes them with retries + DLQ. Each message does a bounded amount of work.

const CRAWL_INTERVAL_MS = 5 * 3600 * 1000;

export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env) {
  for (const msg of batch.messages) {
    try {
      const body = msg.body;
      if (body.type === "crawl") {
        const r = await crawlSource(env, body.sourceId);
        console.log(JSON.stringify({ event: "crawl", sourceId: body.sourceId, ...r }));
      } else if (body.type === "match") {
        const started = now();
        const r = await runMatching(env, body.userId, { full: body.full, cursor: body.cursor });
        if (r.skipped !== "locked") {
          await logRun(env, { kind: "match", status: r.skipped ? "skipped" : "ok", userId: body.userId, startedAt: started, metrics: { evaluated: r.evaluated, stored: r.stored, filtered: r.filtered, aiAnalyses: r.aiAnalyses, aiReasoned: r.aiReasoned, embedded: r.embedded } });
        }
        console.log(JSON.stringify({ event: "match", userId: body.userId, ...r, cursor: undefined }));
        if (r.skipped === "locked") {
          // Another run is in progress. A full re-match must still happen afterwards; an
          // incremental one is redundant (the running pass or the next cron covers it).
          if (body.full) {
            msg.retry({ delaySeconds: 90 });
            continue;
          }
        } else if (r.more && r.cursor) {
          await env.JOBS_QUEUE.send({ type: "match", userId: body.userId, full: body.full, cursor: r.cursor });
        }
      }
      msg.ack();
    } catch (e) {
      const permanent = e instanceof SourceError && !e.retryable;
      console.error(JSON.stringify({ event: "queue_error", body: msg.body, attempts: msg.attempts, error: errorMessage(e) }));
      if (permanent) msg.ack();
      else msg.retry({ delaySeconds: Math.min(600, 30 * 2 ** (msg.attempts - 1)) });
    }
  }
}

/** Enqueue crawls for sources with at least one subscriber that are due. */
export async function enqueueDueCrawls(env: Env, force = false, userId?: string) {
  const cutoff = force ? now() : now() - CRAWL_INTERVAL_MS;
  const rows = userId
    ? await env.DB.prepare(
        `SELECT s.id FROM sources s JOIN user_sources us ON us.source_id = s.id
         WHERE us.user_id = ? AND (s.last_crawled_at IS NULL OR s.last_crawled_at < ?)`,
      )
        .bind(userId, cutoff)
        .all<{ id: string }>()
    : await env.DB.prepare(
        `SELECT s.id FROM sources s WHERE EXISTS (SELECT 1 FROM user_sources us WHERE us.source_id = s.id)
         AND (s.last_crawled_at IS NULL OR s.last_crawled_at < ?) AND COALESCE(s.last_status, '') != 'blocked'`,
      )
        .bind(cutoff)
        .all<{ id: string }>();
  for (const ids of chunk(rows.results, 100)) {
    await env.JOBS_QUEUE.sendBatch(ids.map((r) => ({ body: { type: "crawl", sourceId: r.id } as QueueMessage })));
  }
  return rows.results.length;
}

/** Enqueue matching only for users who have unmatched job updates. */
export async function enqueueDueMatches(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT p.user_id FROM profiles p WHERE EXISTS (
       SELECT 1 FROM user_sources us JOIN jobs j ON j.source_id = us.source_id
       WHERE us.user_id = p.user_id AND j.status = 'open' AND j.updated_at > p.match_watermark)`,
  ).all<{ user_id: string }>();
  for (const ids of chunk(rows.results, 100)) {
    await env.JOBS_QUEUE.sendBatch(ids.map((r) => ({ body: { type: "match", userId: r.user_id } as QueueMessage })));
  }
  return rows.results.length;
}

export async function dailyCleanup(env: Env) {
  if (env.DATA_ENCRYPTION_KEY_PREV) console.log(JSON.stringify({ event: "key_rotation", ...(await reencryptBatch(env)) }));
  const t = now();
  const DAY = 24 * 3600 * 1000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_cache WHERE created_at < ?").bind(t - 30 * DAY),
    // Closed jobs nobody applied to are kept 45 days for history, then removed.
    env.DB.prepare(
      "DELETE FROM jobs WHERE status = 'closed' AND closed_at < ? AND id NOT IN (SELECT job_id FROM applications)",
    ).bind(t - 45 * DAY),
    env.DB.prepare("DELETE FROM ai_usage WHERE created_at < ?").bind(t - 180 * DAY),
    env.DB.prepare("DELETE FROM runs WHERE created_at < ?").bind(t - 90 * DAY),
    // Recover applications stuck mid-preparation (e.g. a workflow instance was terminated).
    env.DB.prepare("UPDATE applications SET status = 'failed', error = 'Preparation timed out', updated_at = ? WHERE status = 'preparing' AND updated_at < ?").bind(t, t - DAY),
  ]);
}

export async function handleScheduled(controller: ScheduledController, env: Env) {
  switch (controller.cron) {
    case "0 */6 * * *":
      console.log(JSON.stringify({ event: "cron_crawl", enqueued: await enqueueDueCrawls(env) }));
      break;
    case "45 */6 * * *":
      console.log(JSON.stringify({ event: "cron_match", enqueued: await enqueueDueMatches(env) }));
      break;
    case "30 * * * *":
      console.log(JSON.stringify({ event: "cron_digest", sent: await sendDueDigests(env) }));
      break;
    case "5 4 * * 1":
      console.log(JSON.stringify({ event: "cron_adapter_health", results: await probeAdapters(env) }));
      break;
    default:
      await dailyCleanup(env);
  }
}
