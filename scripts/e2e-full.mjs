// Full end-to-end test against the local dev server: real D1, R2, Queues, Workflows, Workers AI
// and Browser Rendering. Uses a throwaway user and the local fixture form for submission, so no
// real employer is ever contacted (discovery reads one real public job board).
// Usage: npm run dev   (in another terminal), then   npm run test:e2e:full
const BASE = process.env.APP_URL ?? "http://localhost:5173";
const USER = `e2e-${Date.now()}@applypilot.local`;
const results = [];

async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { "x-dev-user": USER, ...(init.json ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    body: init.json ? JSON.stringify(init.json) : init.body,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
const ok = (r) => r.status >= 200 && r.status < 300;
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
}
async function until(fn, timeoutMs, everyMs = 2500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
const appState = async (id) => (await api(`/applications/${id}`)).body;
const waitStatus = (id, statuses, ms = 180_000) => until(async () => {
  const a = await appState(id);
  return statuses.includes(a?.status) ? a : null;
}, ms);

const CV = `Dev Tester
San Francisco, CA | ${USER} | +1 415 555 0100 | linkedin.com/in/dev-tester

SUMMARY
Backend engineer with 8 years of experience building reliable distributed systems in Python, Go and TypeScript.

SKILLS
Python, Go, TypeScript, Kubernetes, AWS, PostgreSQL, Kafka, Terraform, Docker, gRPC

EXPERIENCE
Senior Software Engineer, Northwind Data — San Francisco, CA — Apr 2021 - Present
- Designed a Kafka-based event pipeline processing 3B events per day with 99.95% availability
- Led migration of 40 services to Kubernetes on AWS, cutting compute cost by 30%

Software Engineer, Contoso Cloud — Seattle, WA — Jan 2018 - Mar 2021
- Developed Python services for usage-based billing on PostgreSQL
- Automated infrastructure provisioning with Terraform across 3 regions

EDUCATION
B.S. Computer Science, University of Washington, 2013 - 2017`;

try {
  // 1. Upload CV → structured resume stored (D1 encrypted + R2 upload).
  const fd = new FormData();
  fd.append("file", new Blob([CV], { type: "text/plain" }), "cv.txt");
  const imp = await api("/resume/import", { method: "POST", body: fd });
  check("CV import parses roles and contact", ok(imp) && imp.body.draft?.experience.length === 2 && imp.body.contact?.email === USER, `${imp.body?.method}`);
  const saved = await api("/resume", { method: "PUT", json: imp.body.draft });
  check("Resume saved", ok(saved) && saved.body.version === 1);

  // 2. Onboarding: preferences + follow one small real board.
  await api("/sources/catalog", { method: "POST", json: { ids: ["greenhouse:lattice"] } });
  const onb = await api("/onboarding/complete", {
    method: "POST",
    json: { locale: "en", timezone: "UTC", personal: { ...imp.body.contact, requiresSponsorship: false, workAuthorizedCountries: ["United States"] }, preferences: { targetTitles: ["Software Engineer"], minScore: 0 } },
  });
  check("Onboarding completed", ok(onb));

  // 3. Discovery + matching through the queue.
  const crawled = await until(async () => {
    const p = (await api("/onboarding/progress")).body;
    return p && p.sources > 0 && p.crawled >= p.sources && p.jobs > 0 ? p : null;
  }, 150_000);
  check("Board crawled via queue", !!crawled, crawled ? `${crawled.jobs} jobs` : "timeout");
  await api("/matching/run", { method: "POST", json: { full: true } });
  const matched = await until(async () => {
    const p = (await api("/onboarding/progress")).body;
    return p && !p.matching && p.matches > 0 ? p : null;
  }, 150_000);
  check("Jobs matched and scored", !!matched, matched ? `${matched.matches} matches` : "timeout");
  const jobs = (await api("/jobs?minScore=0&all=1")).body;
  const withBreakdown = jobs?.items?.[0]?.reasons?.breakdown;
  check("Scores include experience and evidence components", withBreakdown && typeof withBreakdown.experience === "number");

  // 4. Prepare an application for the fixture job (automated adapter, local form).
  const job = (await api("/dev/fixture/job", { method: "POST", json: {} })).body;
  const prep = await api(`/jobs/${job.id}/prepare`, { method: "POST" });
  const appId = prep.body?.id;
  const prepared = appId && (await waitStatus(appId, ["prepared", "failed"]));
  check("Application prepared", prepared?.status === "prepared" && prepared.adapter === "fixture", prepared?.status);
  check("Resume tailored and stored", !!prepared?.tailored && prepared.hasResume);
  check("Quality report produced", typeof prepared?.quality?.score === "number", prepared?.quality ? `score ${prepared.quality.score}` : "");
  const resumeAudit = prepared?.quality?.checks?.find((c) => c.id === "fabrication");
  check("Resume passes fabrication audit", resumeAudit?.ok === true);

  // 5. Missing required answers are detected and approval is blocked until filled.
  const blank = prepared.answers.map((a) => ({ key: a.key, value: a.key === "question_1" ? "" : a.value }));
  const blocked = await api(`/applications/${appId}/approve`, { method: "POST", json: { mode: "dry_run", confirm: true, answers: blank } });
  check("Approval blocked while a required answer is empty", blocked.status === 409, blocked.body?.error?.slice(0, 60));
  const answers = prepared.answers.map((a) => ({ key: a.key, value: a.key === "question_1" ? "No" : a.key === "question_2" ? "I want to work at Fixture Labs because its backend platform matches my Kafka and PostgreSQL work." : a.value }));

  // 6. Dry run: form filled, nothing submitted.
  const before = (await api("/dev/fixture/submissions")).body.submissions;
  const dry = await api(`/applications/${appId}/approve`, { method: "POST", json: { mode: "dry_run", confirm: true, answers } });
  check("Dry run approved", ok(dry), dry.body?.error);
  const afterDry = await waitStatus(appId, ["prepared", "failed", "needs_manual"]);
  const subsDry = (await api("/dev/fixture/submissions")).body.submissions;
  check("Dry run filled the form and sent nothing", afterDry?.status === "prepared" && subsDry === before, afterDry?.events?.[1]?.message?.slice(0, 80));

  // 7. Live submit on the fixture form.
  const live = await api(`/applications/${appId}/approve`, { method: "POST", json: { mode: "live", confirm: true, answers } });
  check("Live submission approved", ok(live) && live.body.mode === "live", live.body?.error);
  const done = await waitStatus(appId, ["submitted", "needs_manual", "failed", "prepared"]);
  const subsLive = (await api("/dev/fixture/submissions")).body.submissions;
  check("Submitted once and confirmation verified", done?.status === "submitted" && !!done.confirmationText && subsLive === before + 1, done?.status);
  const state = (await api(`/dev/fixture/state/${appId}`)).body;
  check("Submission lock and timestamps persisted", !!state.lock && !!state.app.clicked_at && !!state.app.submitted_at);

  // 8. Duplicate protection.
  const again = await api(`/applications/${appId}/approve`, { method: "POST", json: { mode: "live", confirm: true } });
  check("Re-approving a submitted application is refused", again.status === 409);
  const dupJob = (await api("/dev/fixture/job", { method: "POST", json: { dedupeKey: state.app.dedupe_key } })).body;
  const dupPrep = await api(`/jobs/${dupJob.id}/prepare`, { method: "POST" });
  check("Duplicate posting of the same role maps to the existing application", dupPrep.body?.id === appId);

  // Concurrent approvals of one application → at most one click.
  const job2 = (await api("/dev/fixture/job", { method: "POST", json: { title: "Backend Engineer II" } })).body;
  const app2 = (await api(`/jobs/${job2.id}/prepare`, { method: "POST" })).body.id;
  const prepared2 = await waitStatus(app2, ["prepared", "failed"]);
  const answers2 = prepared2.answers.map((a) => ({ key: a.key, value: a.key === "question_1" ? "No" : a.key === "question_2" ? "Fixture Labs builds the kind of data platform I have spent years on." : a.value }));
  const subsBefore2 = (await api("/dev/fixture/submissions")).body.submissions;
  const race = await Promise.all([1, 2, 3].map(() => api(`/applications/${app2}/approve`, { method: "POST", json: { mode: "live", confirm: true, answers: answers2 } })));
  check("Concurrent approvals: exactly one accepted", race.filter(ok).length === 1, race.map((r) => r.status).join(","));
  await waitStatus(app2, ["submitted", "needs_manual", "failed", "prepared"]);
  const subsAfter2 = (await api("/dev/fixture/submissions")).body.submissions;
  check("Concurrent approvals: form submitted exactly once", subsAfter2 === subsBefore2 + 1, `${subsAfter2 - subsBefore2} click(s)`);

  // Browser dies right after clicking: the role stays locked and a retry needs explicit confirmation.
  const job3 = (await api("/dev/fixture/job", { method: "POST", json: { title: "Platform Engineer" } })).body;
  const app3 = (await api(`/jobs/${job3.id}/prepare`, { method: "POST" })).body.id;
  const prepared3 = await waitStatus(app3, ["prepared", "failed"]);
  const sim = (await api(`/dev/fixture/simulate-click/${app3}`, { method: "POST" })).body;
  check("A click can be recorded only once", sim.first === true && sim.second === false);
  const answers3 = prepared3.answers.map((a) => ({ key: a.key, value: a.key === "question_1" ? "No" : a.key === "question_2" ? "Fixture Labs platform work fits my Kafka experience." : a.value }));
  const retry = await api(`/applications/${app3}/approve`, { method: "POST", json: { mode: "live", confirm: true, answers: answers3 } });
  check("Unverified earlier click blocks a silent retry", retry.status === 409 && /could not be verified/i.test(retry.body?.error ?? ""));
  const subsBefore3 = (await api("/dev/fixture/submissions")).body.submissions;
  const confirmed = await api(`/applications/${app3}/approve`, { method: "POST", json: { mode: "live", confirm: true, answers: answers3, confirmNotSubmitted: true } });
  const done3 = ok(confirmed) && (await waitStatus(app3, ["submitted", "needs_manual", "failed"]));
  const subsAfter3 = (await api("/dev/fixture/submissions")).body.submissions;
  check("Retry after explicit confirmation submits once", done3?.status === "submitted" && subsAfter3 === subsBefore3 + 1, done3?.status);

  // 9. Monitoring reflects the runs.
  const m = (await api("/metrics?days=1")).body;
  check("Metrics: discovery, preparation and submissions recorded", m.discovery.total >= 1 && m.preparation.ok >= 3 && (m.submission.outcomes.submitted ?? 0) >= 3 && (m.submission.outcomes.dry_run_ok ?? 0) >= 1);
  check("Metrics: AI cost per application tracked", m.ai.perApplication != null, m.ai.perApplication != null ? `$${m.ai.perApplication.toFixed(5)}/application` : "no AI spend attributed");
} catch (e) {
  check("Unexpected error", false, e.message);
} finally {
  await api("/account", { method: "DELETE", json: { confirm: "DELETE" } }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
