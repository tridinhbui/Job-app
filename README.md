# ApplyPilot

An autonomous job-application agent that runs entirely on Cloudflare: Workers, D1, R2, Queues, Workflows, Cron Triggers, Browser Rendering (Playwright), Workers AI and Cloudflare Access. It uses no external databases, auth providers or AI vendors.

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
| **Application agent** | Greenhouse adapter. The form schema comes from the public Job Board API, so preparation needs no browser time. Answers come from your profile, then your answer library, then AI (open-ended required questions only). Attestations, legal agreements, personal-history questions and preferences are always left for you. Playwright fills the form, uploads the tailored PDF, verifies every value persisted, and detects confirmation. |
| **Safety** | Submission needs **(1)** your approval with a reviewed-answers checkbox, **(2)** `SUBMIT_MODE=live` on the deployment and **(3)** the live toggle in Settings. Dry-run mode blocks every non-GET request from the page, so nothing reaches the employer. Before the submit click, `clicked_at` is set by compare-and-set, so a retried step can never click twice. Duplicates are detected across postings. CAPTCHAs are detected and never bypassed: the application moves to *Needs you*. |
| **Tracker** | Shortlisted → preparing → ready for review → approved → submitting → submitted → interview / offer / rejected / withdrawn, plus *Needs you* and *Failed*. Every transition is a compare-and-set write with an event-history entry. |
| **Cost control** | Every AI call goes through one client: settings check → response cache (D1, 30 days) → budget gate → Workers AI (optional AI Gateway) → schema validation → token and cost accounting. Tasks degrade by priority: match reasoning stops at 60% of budget, JD analysis at 85%, tailoring and answers at 100%. Deterministic fallbacks always work. |

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
npm run dev                           # http://localhost:5173
```

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

- **Automated submission covers Greenhouse only.** Lever, Ashby and JSON-LD jobs are discovered, scored and tailored, then marked for manual application with the tailored resume. New adapters plug into `workflows/prepare.ts` (`adapterFor`) and `workflows/submit.ts`.
- Some Greenhouse boards use invisible reCAPTCHA. If a challenge appears, or no confirmation is detected after submitting, ApplyPilot stops and moves the application to *Needs you*. It never retries a click blindly.
- Live submission has not been exercised against a real employer during development, by design. Every end-to-end test ran in dry-run mode, where outgoing requests are blocked.
- LinkedIn, Indeed and other sites whose terms prohibit automation are intentionally unsupported.
