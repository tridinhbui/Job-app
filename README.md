# ApplyPilot

An autonomous job-application agent that runs entirely on Cloudflare: Workers, D1, R2, Queues, Workflows, Cron Triggers, Browser Rendering (Playwright), Workers AI and Cloudflare Access. It uses no external databases, auth providers or AI vendors.

**v2 — designed to be easy:** a 3-step onboarding (upload resume → confirm what you want → tick companies from a catalog of 75 verified boards) and then one daily loop: open **Today** (or the morning email), review what's prepared, approve. Vietnamese UI by default with an English toggle.

ApplyPilot finds jobs on the boards you follow and scores them against your resume. It tailors an ATS-friendly resume for each role and drafts your application answers. It then fills the real application form in a headless browser, but **only submits after you approve**. Nothing is fabricated, and the AI never clicks buttons.

```
            Cron (6h)                          Dashboard (React SPA, static assets)
               │                                         │  /api/* (Cloudflare Access JWT verified)
               ▼                                         ▼
   ┌─────────── Queue: applypilot-jobs ───────────┐   Hono API ──► D1 (encrypted PII) / R2 (encrypted files)
   │ crawl   → Greenhouse / Lever / Ashby / JSON-LD│      │
   │ match   → filters → score → (AI if useful)    │      ├─► PrepareApplicationWorkflow
   └───────────────────────────────────────────────┘      │     analyze JD → tailor resume → PDF → read form (API) → draft answers
                                                          └─► SubmitApplicationWorkflow (after approval)
                                                                guard → Playwright fill → dry-run | click → verify → record
```

## Features

| Area | What it does |
|---|---|
| **Discovery** | Public Greenhouse, Lever and Ashby board APIs, plus any career page that publishes schema.org `JobPosting` JSON-LD (robots.txt enforced, same-origin, capped). Extracts the JD, salary (structured fields, then regex), location, workplace type, seniority and apply link. Deduplicates within a board and across boards; jobs that disappear are closed. One crawl per board serves every user. |
| **Matching** | Hard filters run first (excluded companies and title keywords, remote policy, location, salary floor, visa sponsorship, seniority distance). A deterministic 0–100 score follows: skills 45, title 25, seniority 10, location 10, salary 10, plus an interests bonus. AI refines the JD analysis only for promising jobs (cached and shared), and re-scores only ambiguous 50–74 scores. |
| **Resume tailoring** | A deterministic reorder (skills and bullets by relevance) always runs. AI rephrasing goes through a **fabrication guard**: it rejects new numbers, new tools or skills, promotional filler, high-novelty wording and over-long rewrites, and restores omitted bullets. Exports ATS-friendly PDF (pdf-lib, no browser) and DOCX. |
| **Easy setup** | Onboarding wizard: resume import extracts contact details (regex, free) and suggests titles/level; company catalog (`shared/companies.json`, verified by `node scripts/verify-companies.mjs`); paste any company name or careers link and the ATS is detected automatically. |
| **Daily loop** | 4 screens — Today, Jobs, Applications, Me. One "Prepare" button per job; "Skip" asks why (company / role / location / pay) and learns from it. Review screen shows only the questions that need you, autosaves, and approves with one confirmation. Auto mode prepares the best 3 matches per day; a 07:30 email digest (Cloudflare Email Service) links straight to the review screen. |
| **Application agent** | Greenhouse adapter. The form schema comes from the public Job Board API, so preparation needs no browser time. Answers come from your profile, then your answer library, then AI (open-ended required questions only). Attestations, legal agreements, personal-history questions and preferences are always left for you. Playwright fills the form, uploads the tailored PDF, verifies every value persisted, and detects confirmation. |
| **Safety** | Submission needs **(1)** your approval with a reviewed-answers checkbox, **(2)** `SUBMIT_MODE=live` on the deployment and **(3)** the live toggle in Settings. Dry-run mode blocks every non-GET request from the page, so nothing reaches the employer. Before the submit click, `clicked_at` is set by compare-and-set, so a retried step can never click twice. Duplicates are detected across postings. CAPTCHAs are detected and never bypassed: the application moves to *Needs you*. |
| **Tracker** | Shortlisted → preparing → ready for review → approved → submitting → submitted → interview / offer / rejected / withdrawn, plus *Needs you* and *Failed*. Every transition is a compare-and-set write with an event-history entry. |
| **Cost control** | Every AI call goes through one client: settings check → response cache (D1, 30 days) → budget gate → Workers AI (optional AI Gateway) → schema validation → token and cost accounting. Tasks degrade by priority: match reasoning stops at 60% of budget, JD analysis at 85%, tailoring and answers at 100%. Deterministic fallbacks always work. |

### v3: reliability & application intelligence

- **No double submission, by construction.** Right before the submit click the engine must win `submission_locks (user, role)` and set `clicked_at` in one atomic D1 batch. Worker retries, timeouts, a browser that dies after clicking, concurrent approvals, duplicate postings of the same role and roles you marked "applied" by hand all hit the same lock. An unverified click can only be retried after you explicitly confirm it did not go through. The lock is released only when the site visibly rejected the form.
- **Smarter matching.** Skills are scored by *evidence*: used in a recent role (1.0, fading to 0.7 for older roles), listed only (0.6) or absent. Relevant years are counted from roles similar to the target title. Seniority, experience, visa (stated / not stated), region-restricted remote, salary and a semantic resume↔job similarity (`bge-small` embeddings, cached per job and shared across users) all contribute. Weights: skills 30 · semantic 15 · title 15 · experience 10 · seniority 10 · location 10 · salary 10.
- **Application quality report** on every prepared application. An independent fabrication audit checks that skills, roles, dates and numbers come from your original resume. Answers are checked for missing required fields, invalid options, length limits, placeholders, relevance and claims your resume doesn't support. Blocking issues prevent approval.
- **Monitoring** (Me → Monitoring): discovery, preparation, form-fill and submission success rates, outcome breakdown, the most frequently failing fields, and AI cost per application (direct and all-in). It is backed by a `runs` log written by every crawl, match, prepare and submit.
- **Full E2E on the real local stack:** `npm run test:e2e:full` (with `npm run dev` running) covers CV upload → discovery (real board) → matching → prepare → quality → dry run → live submit on a local fixture form → status, plus every duplicate scenario. It currently passes 25/25 checks.

### Job-board adapters

| Board | Form read | Submission |
|---|---|---|
| Greenhouse | Job Board API (JSON) | Automated in browser after approval |
| Ashby | Public GraphQL (queries only) | Automated in browser after approval |
| Lever | Apply-page HTML | **Assisted**: answers prepared + copy buttons; you submit (Lever uses hCaptcha) |
| Other / JSON-LD | — | Manual with tailored resume |

All browser adapters share `worker/apply/browser-common.ts`: dry-run blocks every write request (GraphQL *queries* excepted), values are verified after filling, visible CAPTCHA stops the run, and submit is clicked at most once. A weekly canary (`worker/apply/health.ts`) dry-runs one real posting per adapter and flags DOM changes on the Today page.

## AI cost model

Measured from real Workers AI calls in local testing (reported token usage, list prices from Oct 2026):

| Task | Model | Avg tokens in/out | Cost per call |
|---|---|---|---|
| JD analysis (shared across users) | `llama-3.1-8b-instruct-fp8-fast` | 1,556 / 178 | $0.00014 |
| Ambiguous match review | `llama-3.1-8b-instruct-fp8-fast` | 332 / 59 | $0.00004 |
| Resume tailoring | `llama-3.3-70b-instruct-fp8-fast` | 1,169 / 322 | $0.0011 |
| Complex form answers | `llama-3.3-70b-instruct-fp8-fast` | 883 / 164 | $0.0006 |
| Resume import (one-time) | `llama-3.3-70b-instruct-fp8-fast` | 549 / 352 | $0.0010 |

A moderately active user (~30 boards, ~1,500 JD analyses and ~60 prepared applications per month) comes to roughly **$0.20–$0.60/month**, far below the $10 target. Workers AI also includes 10,000 free neurons per day. The budget (default $10) is enforced per user per month and shown in the sidebar.

Other optimizations:
- SPA routes are served as static assets without invoking the Worker (`run_worker_first: ["/api/*"]`).
- Crawls write only changed rows: a content hash skips unchanged jobs, and closures run as batched `IN (...)` updates.
- Only jobs that pass the filters are stored as matches, and matching is incremental via a `(updated_at, id)` keyset watermark.
- Preparation reads the Greenhouse form via JSON, not a browser. The browser runs only for an approved dry run or submission, with images, fonts and media blocked.
- DOCX files are generated on demand rather than stored. Tailored resumes are cached per resume version and JD hash.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars        # set DEV_USER_EMAIL and DATA_ENCRYPTION_KEY (openssl rand -base64 32)
npm run db:migrate:local
npm run dev                           # http://localhost:5173 (uses the local-only "dev" env)
npm run test:e2e                      # browser engine vs. a local fixture form (dev server running)
npm run test:e2e:full                 # whole flow on local D1/R2/Queues/Workflows, isolated test user
```

`npm run dev` runs the `env.dev` configuration (Worker name `applypilot-dev`, dev auth, simulated email) so Workers AI's remote dev proxy never goes through the Access-protected production hostname. Never deploy `env.dev`.

- `AUTH_MODE=dev` is accepted only on `localhost` with `DEV_USER_EMAIL` set. Production always verifies the Cloudflare Access JWT.
- Workers AI always runs remotely, even in local dev (`wrangler login` required), so it incurs real, tiny charges.
- Browser Rendering runs a local Chromium during development.
- Trigger cron handlers locally:
  `curl -X POST "http://localhost:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=applypilot" -H 'content-type: application/json' -d '{"cron":"0 */6 * * *"}'`

```bash
npm test            # unit tests for deterministic logic (parsers, scoring, guard, answers, rendering)
npm run typecheck
```

## Deploy

```bash
npx wrangler login
./scripts/setup-cloudflare.sh
```

The script creates D1, R2 and the queues (plus DLQ), writes the `database_id`, generates `DATA_ENCRYPTION_KEY` as a secret, applies migrations, then builds and deploys. Afterwards:

1. **Cloudflare Access:** in Zero Trust → Access → Applications, add a self-hosted app for the Worker's hostname that allows only your email. Put its AUD tag in `ACCESS_AUD` and `<team>.cloudflareaccess.com` in `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`, then `npm run deploy`. Without these, every API call returns 500 (fail closed).
2. Optional: create an AI Gateway and set `AI_GATEWAY_ID` for request logs and analytics.
3. Keep `SUBMIT_MODE="dry_run"` until you have verified dry runs on the boards you use. Only then set `"live"`, redeploy, and enable live submission in Settings.

**Back up `DATA_ENCRYPTION_KEY`.** Personal data in D1 and every file in R2 is encrypted with it.

**Rotating the key:** set the old key as `DATA_ENCRYPTION_KEY_PREV`, put the new one in `DATA_ENCRYPTION_KEY`, deploy. Reads fall back to the old key and the daily job re-encrypts rows and files in batches; remove `_PREV` once the `key_rotation` log reports `done: true`.

**Daily email digest (optional):** onboard a domain in Cloudflare Email Service, uncomment the `send_email` binding in `wrangler.jsonc`, set `DIGEST_FROM` (e.g. `digest@yourdomain.com`), deploy. Without it the digest is skipped; "Preview today's email" in Me → Automation still works.

### Plans & limits

The Worker bundle is about 1.2 MB gzipped, within the Free plan's 3 MB limit. Queues, Workflows, Browser Rendering and Workers AI all have free tiers. However, matching a large board (hundreds of JDs per page) needs more than the Free plan's 10 ms of CPU per invocation, so **Workers Paid ($5/month)** is recommended for real use.

## Project layout

```
shared/            types + defaults shared by API and UI
worker/
  index.ts         fetch / scheduled / queue handlers, workflow exports
  api.ts           Hono REST API (all routes require Access identity)
  auth.ts          Cloudflare Access JWT verification (jose, cached JWKS)
  background.ts    queue consumer, cron fan-out, daily cleanup
  discovery/       greenhouse, lever, ashby, jsonld (+robots.txt), salary, crawl/reconcile
  matching/        skills dictionary, JD heuristics, filters + scoring, incremental runner
  ai/              budget-aware client, pricing table, prompts + schemas
  resume/          deterministic + guarded AI tailoring, PDF, DOCX, import
  apply/           Greenhouse form schema, answer engine, Playwright adapter
  workflows/       PrepareApplicationWorkflow, SubmitApplicationWorkflow
  db/              profile (encrypted) + application state machine
  lib/             AES-GCM crypto, encrypted R2 storage, utils
migrations/        D1 schema
src/               React + Tailwind dashboard (Overview, Discovery, Queue, Resume Studio, Tracker, Settings)
test/              vitest unit tests
```

## Known limitations

- **Automated submission covers Greenhouse and Ashby.** Lever is assisted (CAPTCHA); other boards are manual. New adapters register in `worker/apply/adapters.ts`.
- Some Greenhouse boards use invisible reCAPTCHA. If a challenge appears, or no confirmation is detected after submitting, ApplyPilot stops and moves the application to *Needs you*. It never retries a click blindly.
- Live submission has not been exercised against a real employer during development, by design. Every end-to-end test ran in dry-run mode, where outgoing requests are blocked.
- LinkedIn, Indeed and other sites whose terms prohibit automation are intentionally unsupported.
