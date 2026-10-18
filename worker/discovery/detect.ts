import { CATALOG } from "../../shared/catalog";
import type { Ats } from "../../shared/types";
import { extractJsonLd } from "./jsonld";
import { SourceError, USER_AGENT } from "./types";

// Turn whatever the user pastes — a company name, an ATS board link, or a company's own
// careers page — into an (ats, token) pair, so nobody has to know what an "ATS token" is.

export interface DetectedSource {
  ats: Ats;
  token: string;
  name?: string;
}

const URL_PATTERNS: [Exclude<Ats, "jsonld">, RegExp][] = [
  ["greenhouse", /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([a-z0-9_-]+)/i],
  ["greenhouse", /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i],
  ["lever", /jobs(?:\.eu)?\.lever\.co\/([a-z0-9_-]+)/i],
  ["lever", /api\.lever\.co\/v0\/postings\/([a-z0-9_-]+)/i],
  ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i],
  ["ashby", /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_.-]+)/i],
];

const IGNORED_TOKENS = new Set(["embed", "api", "v1", "jobs", "job_board", "posting-api"]);

export function detectFromText(text: string): DetectedSource | null {
  for (const [ats, re] of URL_PATTERNS) {
    const m = text.match(re);
    const token = m?.[1]?.toLowerCase();
    if (token && !IGNORED_TOKENS.has(token)) return { ats, token };
  }
  return null;
}

export function findInCatalog(query: string): DetectedSource | null {
  const q = query.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit = CATALOG.find((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, "") === q || c.token === q);
  return hit ? { ats: hit.ats, token: hit.token, name: hit.name } : null;
}

async function boardHasJobs(ats: Exclude<Ats, "jsonld">, token: string): Promise<boolean> {
  const url = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
    lever: `https://api.lever.co/v0/postings/${token}?mode=json&limit=1`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${token}`,
  }[ats];
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) return false;
  const d = (await res.json()) as unknown;
  return ats === "lever" ? Array.isArray(d) : Array.isArray((d as { jobs?: unknown }).jobs);
}

export async function detectSource(input: string): Promise<DetectedSource> {
  const raw = input.trim();
  if (!raw) throw new SourceError("Enter a company name or careers page link", false);

  const looksLikeUrl = /^https?:\/\//i.test(raw) || /\.[a-z]{2,}(\/|$)/i.test(raw);
  if (!looksLikeUrl) {
    const known = findInCatalog(raw);
    if (known) return known;
    // Unknown name: try it as a board token on each ATS.
    const token = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const ats of ["greenhouse", "ashby", "lever"] as const) {
      if (await boardHasJobs(ats, token).catch(() => false)) return { ats, token };
    }
    throw new SourceError(`Couldn't find a public job board for "${raw}". Paste the company's careers page link instead.`, false);
  }

  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  const direct = detectFromText(url.toString());
  if (direct) return direct;

  // A company-hosted careers page: look for an embedded ATS board, then JSON-LD.
  const res = await fetch(url.toString(), { headers: { "user-agent": USER_AGENT, accept: "text/html" } });
  if (!res.ok) throw new SourceError(`Couldn't open that page (HTTP ${res.status})`, false);
  const html = await res.text();
  const embedded = detectFromText(html);
  if (embedded) return embedded;
  if (extractJsonLd(html).length) return { ats: "jsonld", token: url.toString() };
  throw new SourceError("No supported job board (Greenhouse, Lever, Ashby or schema.org JobPosting) found on that page", false);
}
