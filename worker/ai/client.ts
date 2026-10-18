import type { z } from "zod";
import type { UsageSummary, UserSettings } from "../../shared/types";
import { getSettings } from "../db/profile";
import type { Env } from "../env";
import { errorMessage, monthKey, now, sha256Hex, truncate } from "../lib/util";
import { costUsd, estimateTokens } from "./pricing";

// Every AI call goes through here: settings check -> response cache -> budget gate ->
// Workers AI (optionally via AI Gateway) -> schema validation -> usage accounting.

export type AiTask = "jd_analysis" | "match_reasoning" | "resume_tailor" | "form_answers" | "resume_import";

// Lower-priority tasks are switched off first as the monthly budget is consumed,
// so the budget is never exhausted by "nice to have" calls.
const TASK_CEILING: Record<AiTask, number> = {
  match_reasoning: 0.6,
  jd_analysis: 0.85,
  resume_tailor: 1,
  form_answers: 1,
  resume_import: 1,
};

// Models that honour response_format json_schema (per Workers AI docs).
const JSON_MODE_MODELS = new Set([
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3-8b-instruct",
]);

const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

export type AiResult<T> =
  | { ok: true; data: T; cached: boolean; costUsd: number; model: string }
  | { ok: false; reason: "disabled" | "budget" | "error"; message: string };

export interface AiRequest<T> {
  userId: string;
  task: AiTask;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  schema: z.ZodType<T>;
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
}

interface BudgetRow {
  spent_usd: number;
  calls: number;
  cache_hits: number;
  blocked: number;
}

async function budgetRow(env: Env, userId: string, month: string): Promise<BudgetRow> {
  return (
    (await env.DB.prepare("SELECT spent_usd, calls, cache_hits, blocked FROM ai_budget WHERE user_id = ? AND month = ?")
      .bind(userId, month)
      .first<BudgetRow>()) ?? { spent_usd: 0, calls: 0, cache_hits: 0, blocked: 0 }
  );
}

function bump(env: Env, userId: string, month: string, field: "cache_hits" | "blocked") {
  return env.DB.prepare(
    `INSERT INTO ai_budget (user_id, month, ${field}) VALUES (?, ?, 1)
     ON CONFLICT (user_id, month) DO UPDATE SET ${field} = ${field} + 1`,
  )
    .bind(userId, month)
    .run();
}

export function budgetMode(settings: UserSettings, spent: number): UsageSummary["mode"] {
  if (!settings.aiEnabled) return "disabled";
  const ratio = settings.monthlyBudgetUsd > 0 ? spent / settings.monthlyBudgetUsd : 1;
  if (ratio >= 1) return "exhausted";
  if (ratio >= TASK_CEILING.jd_analysis) return "essential";
  if (ratio >= TASK_CEILING.match_reasoning) return "conserve";
  return "normal";
}

export async function usageSummary(env: Env, userId: string): Promise<UsageSummary> {
  const month = monthKey();
  const [settings, row] = await Promise.all([getSettings(env, userId), budgetRow(env, userId, month)]);
  return {
    month,
    budgetUsd: settings.monthlyBudgetUsd,
    spentUsd: row.spent_usd,
    calls: row.calls,
    cacheHits: row.cache_hits,
    blocked: row.blocked,
    mode: budgetMode(settings, row.spent_usd),
  };
}

/** Would a task of this kind be allowed right now? (Cheap pre-check used to skip work early.) */
export async function aiAllowed(env: Env, userId: string, task: AiTask, settings?: UserSettings): Promise<boolean> {
  const s = settings ?? (await getSettings(env, userId));
  if (!s.aiEnabled) return false;
  const row = await budgetRow(env, userId, monthKey());
  return row.spent_usd < s.monthlyBudgetUsd * TASK_CEILING[task];
}

export function parseJsonLoose(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") throw new Error("Empty model response");
  const s = raw.replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model response contained no JSON object");
  return JSON.parse(s.slice(start, end + 1));
}

export async function runJson<T>(env: Env, req: AiRequest<T>): Promise<AiResult<T>> {
  const settings = await getSettings(env, req.userId);
  if (!settings.aiEnabled) return { ok: false, reason: "disabled", message: "AI is disabled in Settings" };

  const month = monthKey();
  const messages = [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ];
  const cacheKey = await sha256Hex(`${req.task}|${req.model}|${JSON.stringify(messages)}`);

  const hit = await env.DB.prepare("SELECT value, created_at FROM ai_cache WHERE key = ?")
    .bind(cacheKey)
    .first<{ value: string; created_at: number }>();
  if (hit && now() - hit.created_at < CACHE_TTL_MS) {
    const parsed = req.schema.safeParse(JSON.parse(hit.value));
    if (parsed.success) {
      await bump(env, req.userId, month, "cache_hits");
      return { ok: true, data: parsed.data, cached: true, costUsd: 0, model: req.model };
    }
  }

  const budget = await budgetRow(env, req.userId, month);
  const estimate = costUsd(req.model, estimateTokens(req.system + req.user), req.maxTokens);
  const ceiling = settings.monthlyBudgetUsd * TASK_CEILING[req.task];
  if (budget.spent_usd + estimate > ceiling) {
    await bump(env, req.userId, month, "blocked");
    return {
      ok: false,
      reason: "budget",
      message: `Monthly AI budget reached for ${req.task} ($${budget.spent_usd.toFixed(3)} of $${settings.monthlyBudgetUsd}); using deterministic fallback`,
    };
  }

  const inputs: Record<string, unknown> = {
    messages,
    max_tokens: req.maxTokens,
    temperature: req.temperature ?? 0.2,
  };
  if (req.jsonSchema && JSON_MODE_MODELS.has(req.model)) {
    inputs.response_format = { type: "json_schema", json_schema: req.jsonSchema };
  }

  let raw: { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  try {
    const options = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
    raw = (await env.AI.run(req.model as keyof AiModels, inputs as never, options)) as typeof raw;
  } catch (e) {
    return { ok: false, reason: "error", message: `Workers AI error: ${truncate(errorMessage(e), 300)}` };
  }

  const reported = raw.usage?.prompt_tokens != null && raw.usage?.completion_tokens != null;
  const inTok = raw.usage?.prompt_tokens ?? estimateTokens(req.system + req.user);
  const outTok =
    raw.usage?.completion_tokens ??
    estimateTokens(typeof raw.response === "string" ? raw.response : JSON.stringify(raw.response ?? ""));
  const cost = costUsd(req.model, inTok, outTok);

  // Account for the spend whether or not the output validates — it was billed either way.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_usage (user_id, month, task, model, input_tokens, output_tokens, cost_usd, estimated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(req.userId, month, req.task, req.model, inTok, outTok, cost, reported ? 0 : 1, now()),
    env.DB.prepare(
      `INSERT INTO ai_budget (user_id, month, spent_usd, calls) VALUES (?, ?, ?, 1)
       ON CONFLICT (user_id, month) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd, calls = calls + 1`,
    ).bind(req.userId, month, cost),
  ]);

  let data: T;
  try {
    const parsed = req.schema.safeParse(parseJsonLoose(raw.response));
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    data = parsed.data;
  } catch (e) {
    return { ok: false, reason: "error", message: `Invalid model output: ${truncate(errorMessage(e), 300)}` };
  }

  await env.DB.prepare("INSERT OR REPLACE INTO ai_cache (key, value, created_at) VALUES (?, ?, ?)")
    .bind(cacheKey, JSON.stringify(data), now())
    .run();
  return { ok: true, data, cached: false, costUsd: cost, model: req.model };
}
