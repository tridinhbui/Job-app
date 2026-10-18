import { Hono } from "hono";
import type { PreparedAnswer } from "../shared/types";
import { runGreenhouseApplication } from "./apply/greenhouse-browser";
import type { Env } from "./env";
import { HttpError } from "./lib/util";

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
