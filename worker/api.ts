import { Hono } from "hono";
import { z } from "zod";
import { defaultPreferences, defaultSettings, emptyPersonal, emptyResume, withDefaults } from "../shared/defaults";
import { SENIORITY_ORDER, type Ats, type AppStatus, type FormField, type PreparedAnswer, type Seniority, type TailoredResume } from "../shared/types";
import { usageSummary } from "./ai/client";
import { getSettings } from "./db/profile";
import { missingRequired, normalizeQuestion } from "./apply/answers";
import { authenticate } from "./auth";
import { CATALOG } from "../shared/catalog";
import { normalizeToken, probeBoard, sourceId } from "./discovery/crawl";
import { detectSource } from "./discovery/detect";
import { dev } from "./dev";
import { refreshQuality, type StoredQuality } from "./apply/quality-store";
import { digestData, emailConfigured, renderDigest } from "./email/digest";
import { SourceError } from "./discovery/types";
import { canTransition, createApplication, getApplication, logEvent, transition } from "./db/applications";
import {
  ensureUser,
  forgetUser,
  getMeta,
  getProfile,
  patchPreferences,
  saveAnswers,
  savePersonal,
  savePreferences,
  saveResume,
  saveSettings,
  type SavedAnswer,
} from "./db/profile";
import type { Env } from "./env";
import { decryptJson, encryptJson, keyring } from "./lib/crypto";
import { deletePrefix, getPrivate, getPrivateJson } from "./lib/storage";
import { errorMessage, HttpError, monthKey, now, safeJson } from "./lib/util";
import { renderResumeDocx } from "./resume/docx";
import { importResume } from "./resume/import";
import { renderResumePdf } from "./resume/pdf";
import { duplicateReason, effectiveMode, SUBMIT_ADAPTERS } from "./workflows/submit";

type Vars = { userId: string; email: string };
const api = new Hono<{ Bindings: Env; Variables: Vars }>().basePath("/api");

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof z.ZodError) return c.json({ error: "Invalid request", issues: err.issues.slice(0, 5) }, 400);
  console.error(JSON.stringify({ event: "api_error", path: c.req.path, error: errorMessage(err) }));
  return c.json({ error: "Internal error" }, 500);
});

api.use("*", async (c, next) => {
  const email = await authenticate(c.req.raw, c.env);
  c.set("email", email);
  c.set("userId", await ensureUser(c.env, email));
  await next();
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
});

const body = async <T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> =>
  schema.parse(await c.req.json().catch(() => ({})));

const str = (max = 500) => z.string().max(max).catch("");
const strList = (max = 100, len = 200) => z.array(z.string().max(len)).max(max).catch([]);

// ---------------- me / overview ----------------

api.get("/me", async (c) => {
  const userId = c.get("userId");
  const [usage, meta, settings] = await Promise.all([usageSummary(c.env, userId), getMeta(c.env, userId), getSettings(c.env, userId)]);
  return c.json({
    email: c.get("email"),
    userId,
    submitMode: c.env.SUBMIT_MODE,
    liveSubmitEnabled: settings.liveSubmitEnabled,
    usage,
    locale: meta.locale,
    timezone: meta.timezone,
    onboarded: meta.onboardedAt != null,
    emailConfigured: emailConfigured(c.env),
  });
});

api.put("/profile/locale", async (c) => {
  const { locale, timezone } = await body(c, z.object({ locale: z.enum(["vi", "en"]), timezone: z.string().max(64).optional() }));
  const tz = timezone && isTimeZone(timezone) ? timezone : null;
  await c.env.DB.prepare("UPDATE profiles SET locale = ?, timezone = COALESCE(?, timezone) WHERE user_id = ?").bind(locale, tz, c.get("userId")).run();
  return c.json({ ok: true });
});

function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------- today (home) ----------------

api.get("/today", async (c) => {
  const userId = c.get("userId");
  const threeDays = now() - 3 * 24 * 3600 * 1000;
  const [todo, fresh, statusCounts, sources, health, usage] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.id, a.status, a.error, a.missing_json, a.updated_at, j.title, j.company, m.score
       FROM applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN matches m ON m.user_id = a.user_id AND m.job_id = a.job_id
       WHERE a.user_id = ? AND a.status IN ('prepared','needs_manual','failed','preparing','approved','submitting')
       ORDER BY CASE a.status WHEN 'prepared' THEN 0 WHEN 'needs_manual' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, m.score DESC LIMIT 20`,
    )
      .bind(userId)
      .all<Record<string, unknown> & { missing_json: string | null }>(),
    c.env.DB.prepare(
      `SELECT m.job_id, m.score, m.reasons_json, j.title, j.company, j.location, j.workplace, j.salary_min, j.salary_max, j.salary_currency, j.salary_period
       FROM matches m JOIN jobs j ON j.id = m.job_id LEFT JOIN applications a ON a.user_id = m.user_id AND a.job_id = m.job_id
       WHERE m.user_id = ? AND m.dismissed = 0 AND j.status = 'open' AND a.id IS NULL AND m.created_at > ?
       ORDER BY m.score DESC LIMIT 5`,
    )
      .bind(userId, threeDays)
      .all<Record<string, unknown> & { reasons_json: string }>(),
    c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM applications WHERE user_id = ? GROUP BY status").bind(userId).all<{ status: AppStatus; n: number }>(),
    c.env.DB.prepare(
      `SELECT s.id, s.company_name, s.last_status, s.last_error, s.last_crawled_at FROM sources s
       JOIN user_sources us ON us.source_id = s.id WHERE us.user_id = ?`,
    )
      .bind(userId)
      .all<{ id: string; company_name: string; last_status: string | null; last_error: string | null; last_crawled_at: number | null }>(),
    c.env.DB.prepare("SELECT ats, checked_at, fill_ratio, ok, message FROM adapter_health WHERE ok = 0").all(),
    usageSummary(c.env, userId),
  ]);
  const totalMatches = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM matches m JOIN jobs j ON j.id = m.job_id WHERE m.user_id = ? AND m.dismissed = 0 AND j.status = 'open'",
  )
    .bind(userId)
    .first<{ n: number }>();

  // Problems the user may need to act on, computed from existing state (no extra writes).
  const incidents: { kind: string; message: string; ref?: string }[] = [];
  for (const s of sources.results.filter((x) => x.last_status === "error" || x.last_status === "blocked")) {
    incidents.push({ kind: "source", ref: s.id, message: `${s.company_name}: ${s.last_error ?? s.last_status}` });
  }
  for (const h of health.results as { ats: string; message: string | null }[]) {
    incidents.push({ kind: "adapter", ref: h.ats, message: h.message ?? `${h.ats} form automation may be out of date` });
  }
  if (usage.mode === "exhausted") incidents.push({ kind: "budget", message: "AI budget reached — using deterministic fallbacks until next month" });

  return c.json({
    todo: todo.results.map(({ missing_json, ...r }) => ({ ...r, missing: safeJson<string[]>(missing_json, []) })),
    fresh: fresh.results.map(({ reasons_json, ...r }) => ({ ...r, reasons: safeJson(reasons_json, null) })),
    statusCounts: Object.fromEntries(statusCounts.results.map((r) => [r.status, r.n])),
    totalMatches: totalMatches?.n ?? 0,
    sources: { total: sources.results.length, crawled: sources.results.filter((x) => x.last_crawled_at).length },
    incidents,
    usage,
  });
});

/** What tomorrow's digest email would contain (also works when email isn't configured). */
api.get("/digest/preview", async (c) => {
  const userId = c.get("userId");
  const meta = await getMeta(c.env, userId);
  const msg = renderDigest(await digestData(c.env, userId, now() - 24 * 3600 * 1000), meta.locale, c.env.APP_URL ?? new URL(c.req.url).origin);
  return c.html(msg ? msg.html : `<p style="font-family:sans-serif">${meta.locale === "vi" ? "Hôm nay chưa có gì mới để gửi." : "Nothing new to send today."}</p>`);
});

// ---------------- onboarding ----------------

api.get("/onboarding/progress", async (c) => {
  const userId = c.get("userId");
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM user_sources WHERE user_id = ?1) AS sources,
       (SELECT COUNT(*) FROM user_sources us JOIN sources s ON s.id = us.source_id WHERE us.user_id = ?1 AND s.last_crawled_at IS NOT NULL) AS crawled,
       (SELECT COUNT(*) FROM jobs j JOIN user_sources us ON us.source_id = j.source_id WHERE us.user_id = ?1 AND j.status = 'open') AS jobs,
       (SELECT COUNT(*) FROM matches WHERE user_id = ?1 AND dismissed = 0) AS matches,
       (SELECT match_lease_until FROM profiles WHERE user_id = ?1) AS lease`,
  )
    .bind(userId)
    .first<{ sources: number; crawled: number; jobs: number; matches: number; lease: number }>();
  return c.json({ ...row, matching: (row?.lease ?? 0) > now() });
});

// ---------------- profile / settings ----------------

const PersonalSchema = z.object({
  firstName: str(100),
  lastName: str(100),
  email: str(200),
  phone: str(50),
  phoneCountry: str(80),
  city: str(100),
  region: str(100),
  country: str(100),
  linkedin: str(300),
  github: str(300),
  website: str(300),
  workAuthorizedCountries: strList(20, 80),
  requiresSponsorship: z.boolean().catch(false),
  willingToRelocate: z.boolean().catch(false),
  earliestStart: str(100),
  noticePeriod: str(100),
  salaryExpectation: str(200),
  howDidYouHear: str(200),
  pronouns: str(50),
  eeo: z.object({ gender: str(100), race: str(100), hispanic: str(100), veteran: str(100), disability: str(100) }).catch(emptyPersonal().eeo),
});

const PreferencesSchema = z.object({
  targetTitles: strList(30),
  excludeTitleKeywords: strList(50, 60),
  seniority: z.array(z.enum(SENIORITY_ORDER as [Seniority, ...Seniority[]])).max(9).catch([]),
  locations: strList(30),
  workplace: z.enum(["remote_only", "remote_or_hybrid", "any"]).catch("any"),
  minSalary: z.number().int().min(0).max(10_000_000).nullable().catch(null),
  salaryCurrency: z.string().length(3).catch("USD"),
  excludedCompanies: strList(200),
  interests: strList(50, 60),
  minScore: z.number().int().min(0).max(100).catch(40),
  excludedLocations: strList(50, 100),
  learned: z.object({ liked: strList(50, 200), disliked: strList(50, 200) }).catch({ liked: [], disliked: [] }),
});

const SettingsSchema = z.object({
  monthlyBudgetUsd: z.number().min(0).max(100).catch(10),
  aiEnabled: z.boolean().catch(true),
  autoShortlistScore: z.number().int().min(0).max(100).catch(0),
  autoPrepare: z.boolean().catch(false),
  autoPrepareDailyLimit: z.number().int().min(0).max(50).catch(5),
  liveSubmitEnabled: z.boolean().catch(false),
  digestEnabled: z.boolean().catch(true),
});

api.get("/profile", async (c) => {
  const p = await getProfile(c.env, c.get("userId"));
  return c.json({ personal: p.personal, preferences: p.preferences, settings: p.settings, answers: p.answers });
});

api.put("/profile/personal", async (c) => {
  const personal = withDefaults(emptyPersonal(), await body(c, PersonalSchema));
  await savePersonal(c.env, c.get("userId"), personal);
  return c.json({ ok: true, personal });
});

api.put("/profile/preferences", async (c) => {
  const prefs = withDefaults(defaultPreferences(), await body(c, PreferencesSchema));
  await savePreferences(c.env, c.get("userId"), prefs);
  await c.env.JOBS_QUEUE.send({ type: "match", userId: c.get("userId"), full: true });
  return c.json({ ok: true, preferences: prefs });
});

api.put("/settings", async (c) => {
  const settings = withDefaults(defaultSettings(), await body(c, SettingsSchema));
  await saveSettings(c.env, c.get("userId"), settings);
  return c.json({ ok: true, settings });
});

api.post("/onboarding/complete", async (c) => {
  const userId = c.get("userId");
  const input = await body(
    c,
    z.object({
      personal: PersonalSchema.partial().catch({}),
      preferences: PreferencesSchema.partial().catch({}),
      timezone: z.string().max(64).optional(),
      locale: z.enum(["vi", "en"]).catch("vi"),
    }),
  );
  const profile = await getProfile(c.env, userId);
  const personal = withDefaults(emptyPersonal(), { ...profile.personal, ...stripEmpty(input.personal) });
  const prefs = withDefaults(defaultPreferences(), { ...profile.preferences, ...input.preferences });
  // Sensible automation defaults: find + prepare the best few each day; never submit on its own.
  const settings = {
    ...profile.settings,
    autoShortlistScore: profile.settings.autoShortlistScore || 75,
    autoPrepare: true,
    autoPrepareDailyLimit: profile.settings.autoPrepareDailyLimit || 3,
    digestEnabled: true,
  };
  await savePersonal(c.env, userId, personal);
  await savePreferences(c.env, userId, prefs);
  await saveSettings(c.env, userId, settings);
  const tz = input.timezone && isTimeZone(input.timezone) ? input.timezone : null;
  await c.env.DB.prepare("UPDATE profiles SET onboarded_at = COALESCE(onboarded_at, ?), locale = ?, timezone = COALESCE(?, timezone) WHERE user_id = ?")
    .bind(now(), input.locale, tz, userId)
    .run();
  await enqueueForce(c.env, userId);
  await c.env.JOBS_QUEUE.send({ type: "match", userId, full: true }, { delaySeconds: 45 });
  return c.json({ ok: true });
});

const stripEmpty = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined && !(Array.isArray(v) && v.length === 0))) as Partial<T>;

api.put("/answers", async (c) => {
  const { answers } = await body(c, z.object({ answers: z.array(z.object({ question: str(500), answer: str(4000) })).max(300) }));
  const list: SavedAnswer[] = answers.filter((a) => a.question.trim() && a.answer.trim()).map((a) => ({ ...a, updatedAt: now() }));
  await saveAnswers(c.env, c.get("userId"), list);
  return c.json({ ok: true, answers: list });
});

// ---------------- resume ----------------

const ResumeSchema = z.object({
  headline: str(200),
  summary: str(3000),
  skills: strList(150, 80),
  experience: z
    .array(
      z.object({
        id: z.string().max(40),
        company: str(200),
        title: str(200),
        location: str(200),
        start: str(10),
        end: str(10),
        bullets: strList(25, 600),
      }),
    )
    .max(30)
    .catch([]),
  education: z
    .array(z.object({ id: z.string().max(40), school: str(200), degree: str(200), field: str(200), start: str(10), end: str(10), details: strList(10, 400) }))
    .max(10)
    .catch([]),
  projects: z
    .array(z.object({ id: z.string().max(40), name: str(200), url: str(300), bullets: strList(10, 600), skills: strList(30, 80) }))
    .max(15)
    .catch([]),
  certifications: strList(30, 200),
});

api.get("/resume", async (c) => {
  const p = await getProfile(c.env, c.get("userId"));
  const tailored = await c.env.DB.prepare(
    `SELECT t.job_id, t.method, t.created_at, t.resume_version, j.title, j.company FROM tailored_resumes t
     JOIN jobs j ON j.id = t.job_id WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 30`,
  )
    .bind(c.get("userId"))
    .all();
  return c.json({ resume: p.resume, version: p.resumeVersion, tailored: tailored.results });
});

api.put("/resume", async (c) => {
  const resume = withDefaults(emptyResume(), await body(c, ResumeSchema));
  const version = await saveResume(c.env, c.get("userId"), resume);
  await c.env.JOBS_QUEUE.send({ type: "match", userId: c.get("userId"), full: true });
  return c.json({ ok: true, version });
});

api.post("/resume/import", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Missing file");
  return c.json(await importResume(c.env, c.get("userId"), file));
});

const fileResponse = (bytes: Uint8Array, type: string, filename: string) =>
  new Response(bytes, {
    headers: { "content-type": type, "content-disposition": `inline; filename="${filename}"`, "cache-control": "private, no-store" },
  });

api.get("/resume/:file{base\\.(?:pdf|docx)}", async (c) => {
  const p = await getProfile(c.env, c.get("userId"));
  const name = `${p.personal.firstName}_${p.personal.lastName}_Resume`.replace(/[^\w-]/g, "_");
  if (c.req.param("file").endsWith(".docx")) {
    return fileResponse(await renderResumeDocx(p.resume, p.personal), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `${name}.docx`);
  }
  return fileResponse(await renderResumePdf(p.resume, p.personal), "application/pdf", `${name}.pdf`);
});

// ---------------- sources / discovery ----------------

api.get("/sources", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.ats, s.token, s.company_name, s.last_crawled_at, s.last_status, s.last_error, s.job_count
     FROM sources s JOIN user_sources us ON us.source_id = s.id WHERE us.user_id = ? ORDER BY s.company_name`,
  )
    .bind(c.get("userId"))
    .all();
  return c.json({ sources: rows.results });
});

api.post("/sources", async (c) => {
  const input = await body(
    c,
    z.object({
      query: z.string().max(500).optional(), // company name or any careers/board URL
      ats: z.enum(["greenhouse", "lever", "ashby", "jsonld"]).optional(),
      token: z.string().max(500).optional(),
      companyName: str(120),
    }),
  );
  let ats: Ats;
  let token: string;
  let detectedName: string | undefined;
  try {
    if (input.query?.trim()) {
      const d = await detectSource(input.query);
      ats = d.ats;
      token = normalizeToken(d.ats, d.token);
      detectedName = d.name;
    } else if (input.ats && input.token) {
      ats = input.ats;
      token = normalizeToken(input.ats, input.token);
    } else throw new SourceError("Enter a company name or careers page link", false);
  } catch (e) {
    throw new HttpError(400, e instanceof SourceError ? e.message : "Invalid board URL or token");
  }
  if (!input.companyName && detectedName) input.companyName = detectedName;
  const id = sourceId(ats, token);
  const existing = await c.env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(id).first();
  if (!existing) {
    let info;
    try {
      info = await probeBoard(ats, token);
    } catch (e) {
      throw new HttpError(400, `Could not read that board: ${errorMessage(e)}`);
    }
    await c.env.DB.prepare("INSERT OR IGNORE INTO sources (id, ats, token, company_name, job_count, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, ats, token, input.companyName.trim() || info.companyName, info.jobCount, now())
      .run();
  }
  await c.env.DB.prepare("INSERT OR IGNORE INTO user_sources (user_id, source_id, created_at) VALUES (?, ?, ?)").bind(c.get("userId"), id, now()).run();
  await c.env.JOBS_QUEUE.send({ type: "crawl", sourceId: id });
  await c.env.JOBS_QUEUE.send({ type: "match", userId: c.get("userId") }, { delaySeconds: 60 });
  return c.json({ ok: true, id, ats, name: input.companyName || null });
});

/** Follow several catalog companies at once (catalog boards are pre-verified, so no probing). */
api.post("/sources/catalog", async (c) => {
  const userId = c.get("userId");
  const { ids } = await body(c, z.object({ ids: z.array(z.string().max(120)).max(100) }));
  const picked = CATALOG.filter((x) => ids.includes(`${x.ats}:${x.token}`));
  if (!picked.length) return c.json({ ok: true, added: 0 });
  const t = now();
  await c.env.DB.batch(
    picked.flatMap((x) => [
      c.env.DB.prepare("INSERT OR IGNORE INTO sources (id, ats, token, company_name, created_at) VALUES (?, ?, ?, ?, ?)").bind(sourceId(x.ats, x.token), x.ats, x.token, x.name, t),
      c.env.DB.prepare("INSERT OR IGNORE INTO user_sources (user_id, source_id, created_at) VALUES (?, ?, ?)").bind(userId, sourceId(x.ats, x.token), t),
    ]),
  );
  await enqueueForce(c.env, userId);
  return c.json({ ok: true, added: picked.length });
});

api.delete("/sources/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM user_sources WHERE user_id = ? AND source_id = ?").bind(c.get("userId"), c.req.param("id")).run();
  return c.json({ ok: true });
});

api.post("/discovery/refresh", async (c) => {
  const userId = c.get("userId");
  // Re-crawl this user's boards unless they were crawled in the last 15 minutes, then match.
  const enqueued = await enqueueForce(c.env, userId);
  await c.env.JOBS_QUEUE.send({ type: "match", userId }, { delaySeconds: enqueued ? 45 : 0 });
  return c.json({ ok: true, crawls: enqueued });
});

async function enqueueForce(env: Env, userId: string) {
  const rows = await env.DB.prepare(
    `SELECT s.id FROM sources s JOIN user_sources us ON us.source_id = s.id
     WHERE us.user_id = ? AND (s.last_crawled_at IS NULL OR s.last_crawled_at < ?)`,
  )
    .bind(userId, now() - 15 * 60 * 1000)
    .all<{ id: string }>();
  if (rows.results.length) await env.JOBS_QUEUE.sendBatch(rows.results.map((r) => ({ body: { type: "crawl" as const, sourceId: r.id } })));
  return rows.results.length;
}

api.post("/matching/run", async (c) => {
  const { full } = await body(c, z.object({ full: z.boolean().catch(false) }));
  await c.env.JOBS_QUEUE.send({ type: "match", userId: c.get("userId"), full });
  return c.json({ ok: true });
});

// ---------------- jobs ----------------

api.get("/jobs", async (c) => {
  const q = c.req.query();
  const minScore = Math.max(0, Math.min(100, Number(q.minScore ?? 0) || 0));
  const offset = Math.max(0, Number(q.offset ?? 0) || 0);
  const where = ["m.user_id = ?", "m.dismissed = 0", "j.status = 'open'", "m.score >= ?"];
  const binds: (string | number)[] = [c.get("userId"), minScore];
  if (q.q?.trim()) {
    where.push("(j.title LIKE ? OR j.company LIKE ? OR j.location LIKE ?)");
    const like = `%${q.q.trim().slice(0, 80)}%`;
    binds.push(like, like, like);
  }
  if (q.workplace && ["remote", "hybrid", "onsite"].includes(q.workplace)) {
    where.push("j.workplace = ?");
    binds.push(q.workplace);
  }
  if (q.hideApplied === "1") where.push("a.id IS NULL");
  if (q.all !== "1") {
    // Postings older than 45 days rarely lead anywhere; hide them unless asked.
    where.push("COALESCE(j.posted_at, j.first_seen_at) > ?");
    binds.push(now() - 45 * 24 * 3600 * 1000);
  }
  const order = q.sort === "recent" ? "j.first_seen_at DESC" : "m.score DESC, j.first_seen_at DESC";
  const rows = await c.env.DB.prepare(
    `SELECT m.job_id, m.score, m.det_score, m.ai_score, m.reasons_json, m.created_at AS matched_at,
       j.title, j.company, j.location, j.workplace, j.seniority, j.employment_type, j.salary_min, j.salary_max,
       j.salary_currency, j.salary_period, j.posted_at, j.first_seen_at, j.job_url, j.source_id,
       a.id AS app_id, a.status AS app_status
     FROM matches m JOIN jobs j ON j.id = m.job_id
     LEFT JOIN applications a ON a.user_id = m.user_id AND a.job_id = m.job_id
     WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 51 OFFSET ?`,
  )
    .bind(...binds, offset)
    .all<Record<string, unknown> & { reasons_json: string }>();
  const items = rows.results.slice(0, 50).map(({ reasons_json, ...r }) => ({ ...r, reasons: safeJson(reasons_json, null) }));
  return c.json({ items, hasMore: rows.results.length > 50 });
});

api.get("/jobs/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const job = await c.env.DB.prepare(
    `SELECT j.*, m.score, m.det_score, m.ai_score, m.reasons_json, a.id AS app_id, a.status AS app_status,
       ja.analysis_json, ja.method AS analysis_method
     FROM jobs j JOIN user_sources us ON us.source_id = j.source_id AND us.user_id = ?
     LEFT JOIN matches m ON m.job_id = j.id AND m.user_id = ?
     LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ?
     LEFT JOIN job_analysis ja ON ja.job_id = j.id
     WHERE j.id = ?`,
  )
    .bind(userId, userId, userId, id)
    .first<Record<string, unknown> & { reasons_json: string | null; analysis_json: string | null }>();
  if (!job) throw new HttpError(404, "Job not found");
  const { reasons_json, analysis_json, ...rest } = job;
  return c.json({ ...rest, reasons: safeJson(reasons_json, null), analysis: safeJson(analysis_json, null) });
});

api.post("/jobs/:id/shortlist", async (c) => {
  const userId = c.get("userId");
  const job = await c.env.DB.prepare(
    "SELECT j.id, j.dedupe_key FROM jobs j JOIN user_sources us ON us.source_id = j.source_id AND us.user_id = ? WHERE j.id = ?",
  )
    .bind(userId, c.req.param("id"))
    .first<{ id: string; dedupe_key: string }>();
  if (!job) throw new HttpError(404, "Job not found");
  const id = await createApplication(c.env, userId, job.id, job.dedupe_key, "Shortlisted");
  if (!id) {
    const existing = await c.env.DB.prepare("SELECT id, status FROM applications WHERE user_id = ? AND (job_id = ? OR dedupe_key = ?)")
      .bind(userId, job.id, job.dedupe_key)
      .first<{ id: string; status: string }>();
    return c.json({ ok: true, id: existing?.id, duplicate: true, status: existing?.status });
  }
  return c.json({ ok: true, id });
});

api.post("/jobs/:id/dismiss", async (c) => {
  const userId = c.get("userId");
  const { reason } = await body(c, z.object({ reason: z.enum(["company", "role", "location", "salary", "other"]).catch("other") }));
  const job = await c.env.DB.prepare("SELECT title, company, location, workplace FROM jobs WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ title: string; company: string; location: string | null; workplace: string | null }>();
  if (!job) throw new HttpError(404, "Job not found");
  const t = now();
  await c.env.DB.prepare("UPDATE matches SET dismissed = 1, skip_reason = ?, updated_at = ? WHERE user_id = ? AND job_id = ?")
    .bind(reason, t, userId, c.req.param("id"))
    .run();
  // Learn from the reason so similar jobs stop showing up.
  if (reason === "company") {
    await patchPreferences(c.env, userId, (p) => ({ ...p, excludedCompanies: [...p.excludedCompanies, job.company] }));
    await c.env.DB.prepare(
      "UPDATE matches SET dismissed = 1, skip_reason = 'company', updated_at = ? WHERE user_id = ? AND dismissed = 0 AND job_id IN (SELECT id FROM jobs WHERE company = ?)",
    )
      .bind(t, userId, job.company)
      .run();
  } else if (reason === "role") {
    await patchPreferences(c.env, userId, (p) => ({ ...p, learned: { ...p.learned, disliked: [...p.learned.disliked, job.title] } }));
  } else if (reason === "location" && job.location && job.workplace !== "remote") {
    const place = job.location.split(/[;|]/)[0]!.split(",")[0]!.trim();
    if (place) await patchPreferences(c.env, userId, (p) => ({ ...p, excludedLocations: [...p.excludedLocations, place] }));
  }
  return c.json({ ok: true });
});

/** One click: shortlist (if needed) and start preparing. Also records the title as "liked". */
api.post("/jobs/:id/prepare", async (c) => {
  const userId = c.get("userId");
  const job = await c.env.DB.prepare(
    "SELECT j.id, j.title, j.dedupe_key FROM jobs j JOIN user_sources us ON us.source_id = j.source_id AND us.user_id = ? WHERE j.id = ?",
  )
    .bind(userId, c.req.param("id"))
    .first<{ id: string; title: string; dedupe_key: string }>();
  if (!job) throw new HttpError(404, "Job not found");
  let appId = await createApplication(c.env, userId, job.id, job.dedupe_key, "Shortlisted");
  if (!appId) {
    const existing = await c.env.DB.prepare("SELECT id FROM applications WHERE user_id = ? AND (job_id = ? OR dedupe_key = ?)")
      .bind(userId, job.id, job.dedupe_key)
      .first<{ id: string }>();
    appId = existing?.id ?? null;
  }
  if (!appId) throw new HttpError(409, "Could not create the application");
  await patchPreferences(c.env, userId, (p) => ({ ...p, learned: { ...p.learned, liked: [...p.learned.liked, job.title] } }));
  const workflowId = await startPrepare(c.env, userId, appId);
  return c.json({ ok: true, id: appId, workflowId });
});

async function startPrepare(env: Env, userId: string, appId: string): Promise<string | null> {
  const app = await getApplication(env, userId, appId);
  if (!["shortlisted", "prepared", "failed", "needs_manual"].includes(app.status)) return app.workflow_id;
  const instanceId = `prep-${app.id}-${app.updated_at}`;
  try {
    await env.PREPARE_WORKFLOW.create({ id: instanceId, params: { applicationId: app.id, userId } });
  } catch (e) {
    if (!/already exists/i.test(errorMessage(e))) throw e;
  }
  await env.DB.prepare("UPDATE applications SET workflow_id = ? WHERE id = ?").bind(instanceId, app.id).run();
  return instanceId;
}

// ---------------- applications ----------------

api.get("/applications", async (c) => {
  const statuses = (c.req.query("status") ?? "").split(",").filter(Boolean);
  const binds: string[] = [c.get("userId"), ...statuses];
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.job_id, a.status, a.adapter, a.tailor_method, a.missing_json, a.submit_mode, a.submitted_at, a.error,
       a.notes, a.created_at, a.updated_at, j.title, j.company, j.location, j.workplace, j.job_url, j.apply_url,
       j.status AS job_status, m.score
     FROM applications a JOIN jobs j ON j.id = a.job_id
     LEFT JOIN matches m ON m.user_id = a.user_id AND m.job_id = a.job_id
     WHERE a.user_id = ? ${statuses.length ? `AND a.status IN (${statuses.map(() => "?").join(",")})` : ""}
     ORDER BY a.updated_at DESC LIMIT 300`,
  )
    .bind(...binds)
    .all<Record<string, unknown> & { missing_json: string | null }>();
  return c.json({ items: rows.results.map(({ missing_json, ...r }) => ({ ...r, missing: safeJson<string[]>(missing_json, []) })) });
});

api.get("/applications/:id", async (c) => {
  const userId = c.get("userId");
  const app = await getApplication(c.env, userId, c.req.param("id"));
  const [job, events, tailored] = await Promise.all([
    c.env.DB.prepare("SELECT id, title, company, location, workplace, job_url, apply_url, status, salary_min, salary_max, salary_currency, salary_period FROM jobs WHERE id = ?")
      .bind(app.job_id)
      .first(),
    c.env.DB.prepare("SELECT id, type, from_status, to_status, message, created_at FROM application_events WHERE application_id = ? ORDER BY id DESC LIMIT 100")
      .bind(app.id)
      .all(),
    app.tailored_key ? getPrivateJson<TailoredResume>(c.env, app.tailored_key) : Promise.resolve(null),
  ]);
  return c.json({
    id: app.id,
    status: app.status,
    adapter: app.adapter,
    tailorMethod: app.tailor_method,
    submitMode: app.submit_mode,
    submittedAt: app.submitted_at,
    confirmationText: app.confirmation_text,
    error: app.error,
    notes: app.notes,
    hasScreenshot: !!app.screenshot_key,
    clicked: !!app.clicked_at,
    hasResume: !!app.resume_pdf_key,
    createdAt: app.created_at,
    updatedAt: app.updated_at,
    answers: await decryptJson<PreparedAnswer[]>(keyring(c.env), app.answers_enc, []),
    missing: safeJson<string[]>(app.missing_json, []),
    form: safeJson<FormField[]>(app.form_json, []),
    quality:
      safeJson<StoredQuality | null>(app.quality_json, null)?.report ??
      // Applications prepared before quality reports existed get one on first view.
      (app.answers_enc && ["prepared", "needs_manual", "failed"].includes(app.status) ? (await refreshQuality(c.env, app, { withResume: true })).report : null),
    tailored,
    job,
    events: events.results,
    globalSubmitMode: c.env.SUBMIT_MODE,
  });
});

api.post("/applications/:id/prepare", async (c) => {
  const userId = c.get("userId");
  const app = await getApplication(c.env, userId, c.req.param("id"));
  if (!["shortlisted", "prepared", "failed", "needs_manual"].includes(app.status)) {
    throw new HttpError(409, `Cannot prepare an application that is ${app.status}`);
  }
  return c.json({ ok: true, workflowId: await startPrepare(c.env, userId, app.id) });
});

api.put("/applications/:id/answers", async (c) => {
  const userId = c.get("userId");
  const app = await getApplication(c.env, userId, c.req.param("id"));
  if (!["prepared", "needs_manual", "failed"].includes(app.status)) throw new HttpError(409, `Answers are locked while ${app.status}`);
  const input = await body(
    c,
    z.object({
      answers: z.array(z.object({ key: z.string().max(100), value: z.union([z.string().max(8000), z.array(z.string().max(500)).max(30)]) })).max(200),
      saveToLibrary: z.boolean().catch(true),
    }),
  );
  const answers = await decryptJson<PreparedAnswer[]>(keyring(c.env), app.answers_enc, []);
  const updates = new Map(input.answers.map((a) => [a.key, a.value]));
  const changed: PreparedAnswer[] = [];
  for (const a of answers) {
    const v = updates.get(a.key);
    if (v === undefined) continue;
    if (JSON.stringify(v) !== JSON.stringify(a.value)) {
      a.value = v;
      a.source = "user";
      a.needsReview = false; // edited by the user
      changed.push(a);
    }
  }
  const missing = missingRequired(answers);
  await c.env.DB.prepare("UPDATE applications SET answers_enc = ?, missing_json = ?, error = ?, updated_at = ? WHERE id = ?")
    .bind(
      await encryptJson(keyring(c.env), answers),
      JSON.stringify(missing),
      missing.length ? `Needs your input: ${missing.join("; ").slice(0, 400)}` : null,
      now(),
      app.id,
    )
    .run();
  const quality = await refreshQuality(c.env, app, { answers });

  if (input.saveToLibrary && changed.length) {
    const profile = await getProfile(c.env, userId);
    const library = [...profile.answers];
    for (const a of changed) {
      if (a.type === "file" || Array.isArray(a.value) || !a.value.trim() || ["first_name", "last_name", "email", "phone"].includes(a.key)) continue;
      const norm = normalizeQuestion(a.label);
      const idx = library.findIndex((l) => normalizeQuestion(l.question) === norm);
      const entry = { question: a.label, answer: a.value, updatedAt: now() };
      if (idx >= 0) library[idx] = entry;
      else library.push(entry);
    }
    await saveAnswers(c.env, userId, library);
  }
  return c.json({ ok: true, missing, quality: quality.report });
});

const AnswerUpdates = z.array(z.object({ key: z.string().max(100), value: z.union([z.string().max(8000), z.array(z.string().max(500)).max(30)]) })).max(200);

/**
 * Approve one prepared application. The confirmation dialog in the UI is the review step:
 * final answers are saved and marked reviewed, then the submit workflow starts.
 */
async function approveApplication(
  env: Env,
  userId: string,
  appId: string,
  requested: "dry_run" | "live",
  updates?: z.infer<typeof AnswerUpdates>,
  confirmNotSubmitted = false,
) {
  const app = await getApplication(env, userId, appId);
  if (app.status !== "prepared") throw new HttpError(409, `Application must be ready for review first (currently ${app.status})`);
  if (!SUBMIT_ADAPTERS.has(app.adapter ?? "")) throw new HttpError(409, "This job board can't be submitted automatically; use assisted apply and mark it submitted");
  const answers = await decryptJson<PreparedAnswer[]>(keyring(env), app.answers_enc, []);
  const byKey = new Map((updates ?? []).map((u) => [u.key, u.value]));
  for (const a of answers) {
    const v = byKey.get(a.key);
    if (v !== undefined && JSON.stringify(v) !== JSON.stringify(a.value)) {
      a.value = v;
      a.source = "user";
    }
    a.needsReview = false;
  }
  const missing = missingRequired(answers);
  if (missing.length) throw new HttpError(409, `Fill the required fields first: ${missing.join("; ")}`);
  const quality = await refreshQuality(env, app, { answers });
  const blockers = quality.report.checks.filter((q) => !q.ok && q.severity === "block");
  if (blockers.length) throw new HttpError(409, `Fix before approving: ${blockers.map((b) => (b.field ? `${b.field}: ${b.message}` : b.message)).join("; ")}`);

  const profile = await getProfile(env, userId);
  const mode = effectiveMode(env, requested, profile.settings.liveSubmitEnabled, app.adapter);
  if (requested === "live" && mode !== "live") {
    throw new HttpError(
      409,
      env.SUBMIT_MODE !== "live"
        ? "Live submission is disabled on this deployment (SUBMIT_MODE=dry_run). Run a dry run instead."
        : "Enable live submission in settings first.",
    );
  }
  if (mode === "live") {
    // Fail fast with a clear message (the submit workflow re-checks atomically).
    const dup = await duplicateReason(env, app, false);
    if (dup && !(confirmNotSubmitted && !dup.startsWith("Duplicate"))) throw new HttpError(409, dup);
  }
  await env.DB.prepare("UPDATE applications SET answers_enc = ?, missing_json = '[]', error = NULL WHERE id = ?")
    .bind(await encryptJson(keyring(env), answers), app.id)
    .run();
  const ok = await transition(env, app, ["prepared"], "approved", mode === "live" ? "Approved for submission by you" : "Approved for a dry run");
  if (!ok) throw new HttpError(409, "Application changed; reload and try again");
  const instanceId = `submit-${app.id}-${app.submit_attempts + 1}`;
  try {
    await env.SUBMIT_WORKFLOW.create({ id: instanceId, params: { applicationId: app.id, userId, mode, confirmNotSubmitted } });
  } catch (e) {
    if (!/already exists/i.test(errorMessage(e))) {
      await transition(env, app, ["approved"], "prepared", "Could not start submission workflow");
      throw e;
    }
  }
  await env.DB.prepare("UPDATE applications SET workflow_id = ? WHERE id = ?").bind(instanceId, app.id).run();
  return { mode, workflowId: instanceId };
}

api.post("/applications/:id/approve", async (c) => {
  const input = await body(
    c,
    z.object({ mode: z.enum(["dry_run", "live"]), confirm: z.literal(true), answers: AnswerUpdates.optional(), confirmNotSubmitted: z.boolean().catch(false) }),
  );
  return c.json({ ok: true, ...(await approveApplication(c.env, c.get("userId"), c.req.param("id"), input.mode, input.answers, input.confirmNotSubmitted)) });
});

/**
 * Approve several complete applications at once (only those with no AI-drafted or personal
 * answers still waiting for review — those need individual attention).
 */
api.post("/applications/approve-batch", async (c) => {
  const userId = c.get("userId");
  const input = await body(c, z.object({ ids: z.array(z.string().max(64)).min(1).max(25), mode: z.enum(["dry_run", "live"]), confirm: z.literal(true) }));
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of input.ids) {
    try {
      const app = await getApplication(c.env, userId, id);
      const answers = await decryptJson<PreparedAnswer[]>(keyring(c.env), app.answers_enc, []);
      if (answers.some((a) => a.needsReview)) throw new HttpError(409, "Has answers that need your review");
      await approveApplication(c.env, userId, id, input.mode);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: errorMessage(e) });
    }
  }
  return c.json({ results });
});

api.post("/applications/:id/status", async (c) => {
  const userId = c.get("userId");
  const input = await body(
    c,
    z.object({
      status: z.enum(["submitted", "interview", "rejected", "offered", "withdrawn", "shortlisted", "prepared"]),
      note: str(1000),
    }),
  );
  const app = await getApplication(c.env, userId, c.req.param("id"));
  if (!canTransition(app.status, input.status)) throw new HttpError(409, `Cannot move from ${app.status} to ${input.status}`);
  const extra: Record<string, number | null> = input.status === "submitted" && !app.submitted_at ? { submitted_at: now() } : {};
  if (input.status === "submitted") {
    // Applied by hand: lock the role so automation never submits it again.
    await c.env.DB.prepare("INSERT OR IGNORE INTO submission_locks (user_id, dedupe_key, application_id, locked_at) VALUES (?, ?, ?, ?)")
      .bind(userId, app.dedupe_key, app.id, now())
      .run();
  }
  const ok = await transition(c.env, app, [app.status], input.status, input.note || `Marked ${input.status}`, extra);
  if (!ok) throw new HttpError(409, "Application changed; reload and try again");
  return c.json({ ok: true });
});

api.post("/applications/:id/notes", async (c) => {
  const userId = c.get("userId");
  const { note } = await body(c, z.object({ note: z.string().min(1).max(2000) }));
  const app = await getApplication(c.env, userId, c.req.param("id"));
  await c.env.DB.prepare("UPDATE applications SET notes = ?, updated_at = ? WHERE id = ?").bind(note, now(), app.id).run();
  await logEvent(c.env, app.id, userId, "note", note);
  return c.json({ ok: true });
});

api.get("/applications/:id/resume.:ext", async (c) => {
  const userId = c.get("userId");
  const app = await getApplication(c.env, userId, c.req.param("id"));
  const p = await getProfile(c.env, userId);
  const name = `${p.personal.firstName}_${p.personal.lastName}_Resume`.replace(/[^\w-]/g, "_");
  if (c.req.param("ext") === "docx") {
    const tailored = app.tailored_key ? await getPrivateJson<TailoredResume>(c.env, app.tailored_key) : null;
    if (!tailored) throw new HttpError(404, "No tailored resume yet");
    return fileResponse(await renderResumeDocx(tailored, p.personal), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `${name}.docx`);
  }
  const pdf = app.resume_pdf_key ? await getPrivate(c.env, app.resume_pdf_key) : null;
  if (!pdf) throw new HttpError(404, "No tailored resume yet");
  return fileResponse(pdf.bytes, "application/pdf", `${name}.pdf`);
});

api.get("/applications/:id/screenshot", async (c) => {
  const app = await getApplication(c.env, c.get("userId"), c.req.param("id"));
  const img = app.screenshot_key ? await getPrivate(c.env, app.screenshot_key) : null;
  if (!img) throw new HttpError(404, "No screenshot");
  return fileResponse(img.bytes, img.contentType, "screenshot.jpg");
});

// ---------------- usage ----------------

api.get("/usage", async (c) => {
  const userId = c.get("userId");
  const month = monthKey();
  const [summary, byTask, recent, months] = await Promise.all([
    usageSummary(c.env, userId),
    c.env.DB.prepare(
      `SELECT task, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost
       FROM ai_usage WHERE user_id = ? AND month = ? GROUP BY task ORDER BY cost DESC`,
    )
      .bind(userId, month)
      .all(),
    c.env.DB.prepare("SELECT task, model, input_tokens, output_tokens, cost_usd, estimated, created_at FROM ai_usage WHERE user_id = ? ORDER BY id DESC LIMIT 25")
      .bind(userId)
      .all(),
    c.env.DB.prepare("SELECT month, spent_usd, calls, cache_hits, blocked FROM ai_budget WHERE user_id = ? ORDER BY month DESC LIMIT 6").bind(userId).all(),
  ]);
  const d = new Date();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = (summary.spentUsd / Math.max(1, d.getUTCDate())) * daysInMonth;
  return c.json({ summary, projectedUsd: projected, byTask: byTask.results, recent: recent.results, months: months.results });
});

// ---------------- monitoring ----------------

api.get("/metrics", async (c) => {
  const userId = c.get("userId");
  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 30) || 30));
  const since = now() - days * 24 * 3600 * 1000;
  const [crawl, prepare, submit, daily, aiTotals, perApp, sharedAi] = await Promise.all([
    // Crawls of the boards this user follows.
    c.env.DB.prepare(
      `SELECT r.status, COUNT(*) AS n, AVG(r.duration_ms) AS avg_ms FROM runs r
       WHERE r.kind = 'crawl' AND r.created_at > ? AND r.ref_id IN (SELECT source_id FROM user_sources WHERE user_id = ?) GROUP BY r.status`,
    )
      .bind(since, userId)
      .all<{ status: string; n: number; avg_ms: number | null }>(),
    c.env.DB.prepare("SELECT status, COUNT(*) AS n, AVG(duration_ms) AS avg_ms FROM runs WHERE kind = 'prepare' AND user_id = ? AND created_at > ? GROUP BY status")
      .bind(userId, since)
      .all<{ status: string; n: number; avg_ms: number | null }>(),
    c.env.DB.prepare("SELECT status, metrics_json FROM runs WHERE kind = 'submit' AND user_id = ? AND created_at > ?").bind(userId, since).all<{ status: string; metrics_json: string | null }>(),
    c.env.DB.prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day, kind, status, COUNT(*) AS n FROM runs
       WHERE user_id = ? AND created_at > ? AND kind IN ('prepare','submit') GROUP BY day, kind, status ORDER BY day`,
    )
      .bind(userId, since)
      .all<{ day: string; kind: string; status: string; n: number }>(),
    c.env.DB.prepare("SELECT task, SUM(cost_usd) AS cost, COUNT(*) AS calls FROM ai_usage WHERE user_id = ? AND created_at > ? GROUP BY task").bind(userId, since).all<{ task: string; cost: number; calls: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT application_id) AS apps, COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage
       WHERE user_id = ? AND created_at > ? AND application_id IS NOT NULL`,
    )
      .bind(userId, since)
      .first<{ apps: number; cost: number }>(),
    c.env.DB.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage WHERE user_id = ? AND created_at > ? AND application_id IS NULL")
      .bind(userId, since)
      .first<{ cost: number }>(),
  ]);

  const rate = (rows: { status: string; n: number }[], okStatuses: string[]) => {
    const total = rows.reduce((a, r) => a + r.n, 0);
    const ok = rows.filter((r) => okStatuses.includes(r.status)).reduce((a, r) => a + r.n, 0);
    return { total, ok, rate: total ? ok / total : null };
  };
  // Form filling: fields filled vs failed across browser runs, and the most common failing fields.
  let filled = 0;
  let failed = 0;
  const failingFields = new Map<string, number>();
  const outcomes: Record<string, number> = {};
  for (const r of submit.results) {
    outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;
    const m = safeJson<{ filled?: number; failed?: number; failedFields?: string[] }>(r.metrics_json, {});
    filled += m.filled ?? 0;
    failed += m.failed ?? 0;
    for (const f of m.failedFields ?? []) failingFields.set(f, (failingFields.get(f) ?? 0) + 1);
  }
  const preparedOk = prepare.results.find((r) => r.status === "ok")?.n ?? 0;
  const appAi = perApp?.cost ?? 0;
  const shared = sharedAi?.cost ?? 0;
  return c.json({
    days,
    discovery: { ...rate(crawl.results, ["ok", "partial"]), byStatus: crawl.results },
    preparation: { ...rate(prepare.results, ["ok"]), avgMs: prepare.results.find((r) => r.status === "ok")?.avg_ms ?? null },
    formFill: { filled, failed, rate: filled + failed ? filled / (filled + failed) : null, topFailing: [...failingFields.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) },
    submission: { outcomes, ...rate(submit.results.map((r) => ({ status: r.status, n: 1 })), ["submitted", "dry_run_ok"]) },
    ai: {
      byTask: aiTotals.results,
      total: appAi + shared,
      perApplication: perApp?.apps ? appAi / perApp.apps : null,
      // Shared work (job analysis, matching) spread over prepared applications.
      allInPerPrepared: preparedOk ? (appAi + shared) / preparedOk : null,
    },
    daily: daily.results,
  });
});

// ---------------- data export / deletion ----------------

api.get("/export", async (c) => {
  const userId = c.get("userId");
  const p = await getProfile(c.env, userId);
  const apps = await c.env.DB.prepare(
    "SELECT a.id, a.status, a.submitted_at, a.notes, a.created_at, j.title, j.company, j.job_url FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ?",
  )
    .bind(userId)
    .all();
  const events = await c.env.DB.prepare("SELECT application_id, type, from_status, to_status, message, created_at FROM application_events WHERE user_id = ?")
    .bind(userId)
    .all();
  return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), profile: p, applications: apps.results, events: events.results }, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="applypilot-export.json"', "cache-control": "no-store" },
  });
});

api.delete("/account", async (c) => {
  const userId = c.get("userId");
  const { confirm } = await body(c, z.object({ confirm: z.literal("DELETE") }));
  if (confirm !== "DELETE") throw new HttpError(400, "Confirmation required");
  await deletePrefix(c.env, `u/${userId}/`);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM application_events WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM applications WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM matches WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM tailored_resumes WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM user_sources WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM ai_usage WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM ai_budget WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM submission_locks WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM runs WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM profiles WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  forgetUser(c.get("email"));
  return c.json({ ok: true });
});

// Local development only (see worker/dev.ts; returns 404 unless AUTH_MODE=dev on localhost).
api.route("/dev", dev);

api.all("*", (c) => c.json({ error: "Not found" }, 404));

export default api;
