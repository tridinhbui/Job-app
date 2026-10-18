import type { Ats } from "../../shared/types";
import type { Env } from "../env";
import { chunk, errorMessage, now, sha256Hex, truncate } from "../lib/util";
import { seniorityFromTitle } from "../matching/analyze";
import { ashbyBoard, ashbyJobs } from "./ashby";
import { greenhouseBoard, greenhouseJobs } from "./greenhouse";
import { jsonLdBoard, jsonLdJobs } from "./jsonld";
import { leverBoard, leverJobs } from "./lever";
import { type BoardInfo, type NormalizedJob, SourceError } from "./types";

const MAX_DESCRIPTION = 24_000;

export function sourceId(ats: Ats, token: string) {
  return `${ats}:${token}`;
}

export function normalizeToken(ats: Ats, raw: string): string {
  const s = raw.trim();
  if (ats === "jsonld") return new URL(s).toString();
  // Accept pasted board URLs as well as bare tokens.
  const patterns: Record<Exclude<Ats, "jsonld">, RegExp> = {
    greenhouse: /greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i,
    lever: /lever\.co\/([a-z0-9_-]+)/i,
    ashby: /ashbyhq\.com\/(?:posting-api\/job-board\/)?([a-z0-9_.-]+)/i,
  };
  const m = s.match(patterns[ats]);
  const token = (m?.[1] ?? s).toLowerCase();
  if (!/^[a-z0-9_.-]{1,80}$/.test(token)) throw new SourceError("Invalid board token", false);
  return token;
}

export async function probeBoard(ats: Ats, token: string): Promise<BoardInfo> {
  switch (ats) {
    case "greenhouse":
      return greenhouseBoard(token);
    case "lever":
      return leverBoard(token);
    case "ashby":
      return ashbyBoard(token);
    case "jsonld":
      return jsonLdBoard(token);
  }
}

function fetchJobs(ats: Ats, token: string, company: string | null): Promise<NormalizedJob[]> {
  switch (ats) {
    case "greenhouse":
      return greenhouseJobs(token, company);
    case "lever":
      return leverJobs(token, company);
    case "ashby":
      return ashbyJobs(token, company);
    case "jsonld":
      return jsonLdJobs(token, company);
  }
}

const norm = (s: string | null) =>
  (s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function dedupeKey(j: Pick<NormalizedJob, "company" | "title" | "location">) {
  return `${norm(j.company)}|${norm(j.title)}|${norm(j.location).split(" ").slice(0, 3).join(" ")}`;
}

export interface CrawlResult {
  total: number;
  inserted: number;
  updated: number;
  closed: number;
}

/**
 * Crawl one source and reconcile with D1. Writes only rows that actually changed:
 * new jobs, jobs whose content hash changed, and jobs that disappeared (closed).
 */
export async function crawlSource(env: Env, id: string): Promise<CrawlResult> {
  const source = await env.DB.prepare("SELECT ats, token, company_name, job_count FROM sources WHERE id = ?")
    .bind(id)
    .first<{ ats: Ats; token: string; company_name: string | null; job_count: number }>();
  if (!source) return { total: 0, inserted: 0, updated: 0, closed: 0 };

  const t = now();
  let jobs: NormalizedJob[];
  try {
    jobs = await fetchJobs(source.ats, source.token, source.company_name);
  } catch (e) {
    const permanent = e instanceof SourceError && !e.retryable;
    await env.DB.prepare("UPDATE sources SET last_crawled_at = ?, last_status = ?, last_error = ? WHERE id = ?")
      .bind(t, permanent ? "blocked" : "error", truncate(errorMessage(e), 500), id)
      .run();
    if (permanent) return { total: 0, inserted: 0, updated: 0, closed: 0 };
    throw e; // transient: let the queue retry with backoff
  }

  const existing = await env.DB.prepare("SELECT id, external_id, content_hash, status FROM jobs WHERE source_id = ?")
    .bind(id)
    .all<{ id: string; external_id: string; content_hash: string; status: string }>();
  const byExternal = new Map(existing.results.map((r) => [r.external_id, r]));

  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  const newKeys: { id: string; key: string }[] = [];
  let inserted = 0;
  let updated = 0;

  for (const j of jobs) {
    if (seen.has(j.externalId)) continue;
    seen.add(j.externalId);
    const description = truncate(j.description, MAX_DESCRIPTION);
    const s = j.salary;
    const hash = (
      await sha256Hex([j.title, j.location, j.workplace, description, s?.min, s?.max, j.applyUrl].join("|"))
    ).slice(0, 24);
    const prev = byExternal.get(j.externalId);
    if (prev && prev.content_hash === hash && prev.status === "open") continue;

    const key = dedupeKey(j);
    const values = [
      j.company,
      j.title,
      j.location,
      j.workplace,
      seniorityFromTitle(j.title),
      j.employmentType,
      j.department,
      s?.min ?? null,
      s?.max ?? null,
      s?.currency ?? null,
      s?.period ?? null,
      description,
      j.applyUrl,
      j.jobUrl,
      j.postedAt,
      hash,
      key,
    ];
    if (prev) {
      updated++;
      stmts.push(
        env.DB.prepare(
          `UPDATE jobs SET company=?, title=?, location=?, workplace=?, seniority=?, employment_type=?, department=?,
             salary_min=?, salary_max=?, salary_currency=?, salary_period=?, description=?, apply_url=?, job_url=?,
             posted_at=?, content_hash=?, dedupe_key=?, status='open', closed_at=NULL, updated_at=? WHERE id=?`,
        ).bind(...values, t, prev.id),
      );
    } else {
      inserted++;
      const jobId = (await sha256Hex(`${id}|${j.externalId}`)).slice(0, 24);
      newKeys.push({ id: jobId, key });
      stmts.push(
        env.DB.prepare(
          `INSERT INTO jobs (company, title, location, workplace, seniority, employment_type, department,
             salary_min, salary_max, salary_currency, salary_period, description, apply_url, job_url,
             posted_at, content_hash, dedupe_key, id, source_id, external_id, first_seen_at, updated_at, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open')
           ON CONFLICT (source_id, external_id) DO NOTHING`,
        ).bind(...values, jobId, id, j.externalId, t, t),
      );
    }
  }

  // Expired listings: open jobs no longer on the board. Guard against a transient empty response.
  const suspiciousEmpty = jobs.length === 0 && source.job_count > 5;
  const toClose = suspiciousEmpty
    ? []
    : existing.results.filter((r) => r.status === "open" && !seen.has(r.external_id)).map((r) => r.id);
  for (const ids of chunk(toClose, 50)) {
    stmts.push(
      env.DB.prepare(
        `UPDATE jobs SET status='closed', closed_at=?, updated_at=? WHERE id IN (${ids.map(() => "?").join(",")})`,
      ).bind(t, t, ...ids),
    );
  }

  for (const batch of chunk(stmts, 50)) await env.DB.batch(batch);

  // Cross-source duplicates (same company/title/location on two boards): keep the older one.
  for (const group of chunk(newKeys, 40)) {
    const placeholders = group.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE jobs SET duplicate_of = (
         SELECT o.id FROM jobs o WHERE o.dedupe_key = jobs.dedupe_key AND o.source_id != jobs.source_id
           AND o.status = 'open' AND o.duplicate_of IS NULL ORDER BY o.first_seen_at LIMIT 1)
       WHERE id IN (${placeholders}) AND EXISTS (
         SELECT 1 FROM jobs o WHERE o.dedupe_key = jobs.dedupe_key AND o.source_id != jobs.source_id
           AND o.status = 'open' AND o.duplicate_of IS NULL)`,
    )
      .bind(...group.map((g) => g.id))
      .run();
  }

  await env.DB.prepare(
    "UPDATE sources SET last_crawled_at=?, last_status=?, last_error=?, job_count=? WHERE id=?",
  )
    .bind(t, "ok", suspiciousEmpty ? "Board returned 0 jobs; kept existing listings open" : null, seen.size, id)
    .run();

  return { total: seen.size, inserted, updated, closed: toClose.length };
}
