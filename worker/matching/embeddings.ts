import type { BaseResume } from "../../shared/types";
import { aiAllowed } from "../ai/client";
import { costUsd, estimateTokens } from "../ai/pricing";
import type { Env } from "../env";
import { b64decode, b64encode } from "../lib/crypto";
import { chunk, errorMessage, monthKey, now, truncate } from "../lib/util";

// Semantic similarity between the resume and a job, so matching isn't purely keyword-based.
// bge-small (384-d) costs ~$0.02 per million tokens; job vectors are cached per content hash
// and shared by all users, the resume vector per resume version.

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
const JOB_CHARS = 1600;
const RESUME_CHARS = 2400;

export const toB64 = (v: number[]) => b64encode(new Uint8Array(new Float32Array(v).buffer));
export const fromB64 = (s: string) => Array.from(new Float32Array(b64decode(s).buffer));

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Map raw cosine (bge-small: unrelated ≈0.45, near-identical ≈0.9) to 0..1. */
export const semanticFit = (cos: number) => Math.max(0, Math.min(1, (cos - 0.5) / (0.85 - 0.5)));

export const jobEmbedText = (j: { title: string; description: string }) => truncate(`${j.title}\n${j.description}`, JOB_CHARS);

export function resumeEmbedText(r: BaseResume): string {
  return truncate(
    [r.headline, r.summary, r.skills.join(", "), ...r.experience.flatMap((e) => [e.title, ...e.bullets.slice(0, 4)])].filter(Boolean).join("\n"),
    RESUME_CHARS,
  );
}

async function embed(env: Env, userId: string, texts: string[]): Promise<number[][] | null> {
  try {
    const out = (await env.AI.run(EMBED_MODEL, { text: texts, pooling: "cls" })) as { data?: number[][] };
    if (!out.data || out.data.length !== texts.length) return null;
    const tokens = texts.reduce((a, t) => a + estimateTokens(t), 0);
    const cost = costUsd(EMBED_MODEL, tokens, 0);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO ai_usage (user_id, month, task, model, input_tokens, output_tokens, cost_usd, estimated, created_at) VALUES (?, ?, 'embedding', ?, ?, 0, ?, 1, ?)",
      ).bind(userId, monthKey(), EMBED_MODEL, tokens, cost, now()),
      env.DB.prepare(
        `INSERT INTO ai_budget (user_id, month, spent_usd, calls) VALUES (?, ?, ?, 1)
         ON CONFLICT (user_id, month) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd, calls = calls + 1`,
      ).bind(userId, monthKey(), cost),
    ]);
    return out.data;
  } catch (e) {
    console.error(JSON.stringify({ event: "embed_error", error: errorMessage(e) }));
    return null;
  }
}

/** Resume vector, recomputed only when the resume version changes. */
export async function resumeVector(env: Env, userId: string, resume: BaseResume, version: number): Promise<number[] | null> {
  const row = await env.DB.prepare("SELECT resume_vector, resume_vector_version FROM profiles WHERE user_id = ?")
    .bind(userId)
    .first<{ resume_vector: string | null; resume_vector_version: number }>();
  if (row?.resume_vector && row.resume_vector_version === version) return fromB64(row.resume_vector);
  if (!(await aiAllowed(env, userId, "jd_analysis"))) return null;
  const text = resumeEmbedText(resume);
  if (text.length < 40) return null;
  const v = (await embed(env, userId, [text]))?.[0];
  if (!v) return null;
  await env.DB.prepare("UPDATE profiles SET resume_vector = ?, resume_vector_version = ? WHERE user_id = ?").bind(toB64(v), version, userId).run();
  return v;
}

/** Vectors for jobs (cached by content hash); missing ones are embedded in batches if the budget allows. */
export async function jobVectors(
  env: Env,
  userId: string,
  jobs: { id: string; content_hash: string; title: string; description: string }[],
): Promise<{ vectors: Map<string, number[]>; embedded: number }> {
  const vectors = new Map<string, number[]>();
  if (!jobs.length) return { vectors, embedded: 0 };
  for (const ids of chunk(jobs.map((j) => j.id), 90)) {
    const rows = await env.DB.prepare(`SELECT job_id, content_hash, vector FROM job_embeddings WHERE job_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ job_id: string; content_hash: string; vector: string }>();
    const hash = new Map(jobs.map((j) => [j.id, j.content_hash]));
    for (const r of rows.results) if (hash.get(r.job_id) === r.content_hash) vectors.set(r.job_id, fromB64(r.vector));
  }
  const missing = jobs.filter((j) => !vectors.has(j.id));
  let embedded = 0;
  if (missing.length && (await aiAllowed(env, userId, "jd_analysis"))) {
    for (const group of chunk(missing, 50)) {
      const out = await embed(env, userId, group.map(jobEmbedText));
      if (!out) break;
      const t = now();
      await env.DB.batch(
        group.map((j, i) =>
          env.DB.prepare(
            `INSERT INTO job_embeddings (job_id, content_hash, model, vector, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (job_id) DO UPDATE SET content_hash = excluded.content_hash, model = excluded.model, vector = excluded.vector, created_at = excluded.created_at`,
          ).bind(j.id, j.content_hash, EMBED_MODEL, toB64(out[i]!), t),
        ),
      );
      group.forEach((j, i) => vectors.set(j.id, out[i]!));
      embedded += group.length;
    }
  }
  return { vectors, embedded };
}
