import { Hono } from "hono";
import type { PreparedAnswer } from "../shared/types";
import { runGreenhouseApplication } from "./apply/greenhouse-browser";
import type { Env } from "./env";
import { HttpError } from "./lib/util";
import { acquireSubmitLock } from "./workflows/submit";

// Local-development-only routes (AUTH_MODE=dev on localhost): a fixture application form that
// mimics Greenhouse's DOM, and an end-to-end check of the real browser engine against it.
// Proves, without touching any employer: dry run never submits, live clicks exactly once,
// and a retry after a click never clicks again.

let submissions = 0;

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture application</title>
<style>body{font-family:sans-serif;max-width:640px;margin:40px auto}label{display:block;margin-top:12px}
[role=listbox]{border:1px solid #ccc}[role=option]{padding:4px;cursor:pointer}.select__control{border:1px solid #999;padding:4px}</style></head>
<body><h1>Apply: Fixture Engineer</h1><form id="f" onsubmit="return false">
<label>First Name <input id="first_name" required></label>
<label>Last Name <input id="last_name" required></label>
<label>Email <input id="email" required></label>
<label>Resume <input id="resume" type="file"></label><div id="resume_name"></div>
<label>Do you require sponsorship?</label>
<div class="select__control"><span class="value"></span><input id="question_1" role="combobox" autocomplete="off"></div>
<div id="menu" role="listbox" hidden><div role="option">Yes</div><div role="option">No</div></div>
<label>Why us? <textarea id="question_2"></textarea></label>
<button type="submit" id="submit">Submit application</button></form>
<script>
const combo=document.getElementById('question_1'),menu=document.getElementById('menu'),val=document.querySelector('.value');
combo.addEventListener('click',()=>{menu.hidden=false});
combo.addEventListener('input',()=>{menu.hidden=false;for(const o of menu.children)o.hidden=!o.textContent.toLowerCase().startsWith(combo.value.toLowerCase())});
for(const o of menu.children)o.addEventListener('click',()=>{val.textContent=o.textContent;combo.value='';menu.hidden=true});
document.getElementById('resume').addEventListener('change',e=>{document.getElementById('resume_name').textContent=e.target.files[0]?.name||''});
document.getElementById('submit').addEventListener('click',async()=>{
  const r=await fetch('/api/dev/fixture/submit',{method:'POST'}).catch(()=>null);
  if(r&&r.ok)document.body.innerHTML='<h1>Thank you for applying!</h1>';
});
</script></body></html>`;

export const dev = new Hono<{ Bindings: Env }>();

dev.use("*", async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (c.env.AUTH_MODE !== "dev" || !(host === "localhost" || host === "127.0.0.1")) throw new HttpError(404, "Not found");
  await next();
});

dev.get("/fixture/greenhouse", (c) => c.html(FIXTURE));

/** Greenhouse-style schema of the fixture form (read by the "fixture" adapter). */
dev.get("/fixture/questions", (c) =>
  c.json([
    { key: "first_name", label: "First Name", type: "text", required: true, options: [], description: "", section: "main" },
    { key: "last_name", label: "Last Name", type: "text", required: true, options: [], description: "", section: "main" },
    { key: "email", label: "Email", type: "text", required: true, options: [], description: "", section: "main" },
    { key: "resume", label: "Resume/CV", type: "file", required: false, options: [], description: "", section: "main" },
    { key: "question_1", label: "Will you now or in the future require visa sponsorship?", type: "select", required: true, options: [{ label: "Yes", value: "1" }, { label: "No", value: "0" }], description: "", section: "main" },
    { key: "question_2", label: "Why do you want to work at Fixture Labs?", type: "textarea", required: true, options: [], description: "", section: "main" },
  ]),
);

dev.get("/fixture/submissions", (c) => c.json({ submissions }));

/** Create a fixture job (followed by the caller) whose apply URL is the local fixture form. */
dev.post("/fixture/job", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { dedupeKey?: string; title?: string; userEmail?: string };
  const email = c.req.header("x-dev-user") ?? c.env.DEV_USER_EMAIL ?? "";
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email.toLowerCase()).first<{ id: string }>();
  if (!user) throw new HttpError(400, "Unknown user");
  const t = Date.now();
  const sourceId = "greenhouse:applypilot-fixture";
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const title = body.title ?? "Senior Backend Engineer";
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO sources (id, ats, token, company_name, created_at, last_status) VALUES (?, 'greenhouse', 'applypilot-fixture', 'Fixture Labs', ?, 'blocked')").bind(sourceId, t),
    c.env.DB.prepare("INSERT OR IGNORE INTO user_sources (user_id, source_id, created_at) VALUES (?, ?, ?)").bind(user.id, sourceId, t),
    c.env.DB.prepare(
      `INSERT INTO jobs (id, source_id, external_id, company, title, location, workplace, seniority, description, apply_url, job_url, first_seen_at, updated_at, content_hash, dedupe_key)
       VALUES (?, ?, ?, 'Fixture Labs', ?, 'San Francisco, CA', 'hybrid', 'senior', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      sourceId,
      id,
      title,
      "Requirements:\n- 5+ years building backend services in Python or Go\n- Kafka, PostgreSQL, Kubernetes on AWS",
      `${new URL(c.req.url).origin}/api/dev/fixture/greenhouse`,
      `${new URL(c.req.url).origin}/api/dev/fixture/greenhouse`,
      t,
      t,
      id,
      body.dedupeKey ?? `fixture labs|${id}`,
    ),
  ]);
  return c.json({ id });
});

/** Inspect duplicate-protection state for an application. */
dev.get("/fixture/state/:appId", async (c) => {
  const app = await c.env.DB.prepare("SELECT id, user_id, status, clicked_at, submitted_at, dedupe_key FROM applications WHERE id = ?").bind(c.req.param("appId")).first<Record<string, unknown>>();
  const lock = app ? await c.env.DB.prepare("SELECT application_id, locked_at FROM submission_locks WHERE user_id = ? AND dedupe_key = ?").bind(app.user_id, app.dedupe_key).first() : null;
  return c.json({ app, lock });
});

/** Simulate the browser dying right after a click: the lock is taken, nothing is recorded. */
dev.post("/fixture/simulate-click/:appId", async (c) => {
  const app = await c.env.DB.prepare("SELECT user_id, dedupe_key FROM applications WHERE id = ?").bind(c.req.param("appId")).first<{ user_id: string; dedupe_key: string }>();
  if (!app) throw new HttpError(404, "Not found");
  const first = await acquireSubmitLock(c.env, app.user_id, c.req.param("appId"), app.dedupe_key);
  const second = await acquireSubmitLock(c.env, app.user_id, c.req.param("appId"), app.dedupe_key);
  return c.json({ first, second });
});
dev.post("/fixture/submit", (c) => {
  submissions++;
  return c.json({ ok: true, submissions });
});

dev.post("/e2e", async (c) => {
  const url = `${new URL(c.req.url).origin}/api/dev/fixture/greenhouse`;
  const answers: PreparedAnswer[] = [
    { key: "first_name", label: "First Name", type: "text", required: true, value: "Fixture", source: "profile", needsReview: false },
    { key: "last_name", label: "Last Name", type: "text", required: true, value: "Tester", source: "profile", needsReview: false },
    { key: "email", label: "Email", type: "text", required: true, value: "fixture@example.invalid", source: "profile", needsReview: false },
    { key: "resume", label: "Resume", type: "file", required: false, value: "resume", source: "file", needsReview: false },
    { key: "question_1", label: "Sponsorship", type: "select", required: true, value: "No", source: "profile", needsReview: false },
    { key: "question_2", label: "Why us?", type: "textarea", required: true, value: "Because the fixture is great.", source: "user", needsReview: false },
  ];
  const resume = { name: "fixture.pdf", bytes: new TextEncoder().encode("%PDF-1.4 fixture") };
  let clicked = false;
  const beforeClick = async () => {
    if (clicked) return false;
    clicked = true;
    return true;
  };
  const base = { applyUrl: url, answers, resume, phoneCountry: "", beforeClick };

  submissions = 0;
  const dry = await runGreenhouseApplication(c.env, { ...base, mode: "dry_run" });
  const afterDry = submissions;
  const live = await runGreenhouseApplication(c.env, { ...base, mode: "live" });
  const afterLive = submissions;
  const retry = await runGreenhouseApplication(c.env, { ...base, mode: "live" });
  const afterRetry = submissions;

  const checks = {
    dryRunFilledEverything: dry.outcome === "dry_run_ok" && dry.failed.length === 0,
    dryRunSentNothing: afterDry === 0,
    liveSubmittedOnce: live.outcome === "submitted" && afterLive === 1,
    retryNeverClicksAgain: retry.outcome === "unverified" && afterRetry === 1,
  };
  const strip = (r: typeof dry) => ({ outcome: r.outcome, filled: r.filled, failed: r.failed, message: r.message, blockedWrites: r.blockedWrites });
  return c.json({ ok: Object.values(checks).every(Boolean), checks, runs: { dry: strip(dry), live: strip(live), retry: strip(retry) } });
});
