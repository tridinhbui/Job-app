import type { Workplace } from "../../shared/types";
import { htmlToText, sha256Hex } from "../lib/util";
import { extractSalary, normalizePeriod } from "./salary";
import { type BoardInfo, type NormalizedJob, SourceError, USER_AGENT } from "./types";

// Generic adapter for company career pages that publish schema.org JobPosting JSON-LD.
// Only crawls pages allowed by robots.txt, same-origin only, with a hard page cap.

const MAX_DETAIL_PAGES = 25;

// ---------- robots.txt ----------

interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export function parseRobots(text: string, agent = "applypilotbot"): RobotsRules {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" && value) current.allow.push(value);
    if (field === "disallow" && value) current.disallow.push(value);
  }
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const group = specific ?? groups.find((g) => g.agents.includes("*"));
  return { allow: group?.allow ?? [], disallow: group?.disallow ?? [] };
}

function ruleMatches(rule: string, path: string): number {
  // Supports "*" wildcards and "$" end anchors; returns match length (specificity) or -1.
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = new RegExp("^" + body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path) ? body.length : -1;
}

export function isAllowed(rules: RobotsRules, path: string): boolean {
  let best = -1;
  let allowed = true;
  for (const r of rules.disallow) {
    const n = ruleMatches(r, path);
    if (n > best) {
      best = n;
      allowed = false;
    }
  }
  for (const r of rules.allow) {
    const n = ruleMatches(r, path);
    if (n >= best && n >= 0) {
      best = n;
      allowed = true;
    }
  }
  return allowed;
}

async function loadRobots(origin: string): Promise<RobotsRules> {
  const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": USER_AGENT } });
  if (res.status >= 500) throw new SourceError(`robots.txt unavailable (${res.status})`, true);
  if (!res.ok) return { allow: [], disallow: [] }; // 4xx: no restrictions per RFC 9309
  return parseRobots(await res.text());
}

// ---------- JSON-LD extraction ----------

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" } });
  if (res.status === 404) throw new SourceError(`Page not found: ${url}`, false);
  if (!res.ok) throw new SourceError(`Upstream ${res.status}: ${url}`, res.status >= 500 || res.status === 429);
  return res.text();
}

export function extractJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) out.push(obj);
    if (obj["@graph"]) visit(obj["@graph"]);
  };
  for (const m of html.matchAll(re)) {
    try {
      visit(JSON.parse(m[1]!.trim()));
    } catch {
      /* malformed block: skip */
    }
  }
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function locationOf(p: Record<string, unknown>): string | null {
  const locs = Array.isArray(p.jobLocation) ? p.jobLocation : p.jobLocation ? [p.jobLocation] : [];
  const names = locs
    .map((l) => {
      const a = (l as { address?: Record<string, unknown> })?.address;
      if (!a) return "";
      const country = typeof a.addressCountry === "object" ? str((a.addressCountry as { name?: unknown }).name) : str(a.addressCountry);
      return [str(a.addressLocality), str(a.addressRegion), country].filter(Boolean).join(", ");
    })
    .filter(Boolean);
  return names.join("; ") || null;
}

export function postingToJob(p: Record<string, unknown>, pageUrl: string, fallbackCompany: string): NormalizedJob | null {
  const title = str(p.title).trim();
  if (!title) return null;
  const validThrough = Date.parse(str(p.validThrough));
  if (validThrough && validThrough < Date.now()) return null; // expired listing
  const description = htmlToText(str(p.description));
  const org = p.hiringOrganization as { name?: unknown } | undefined;
  const ident = p.identifier as { value?: unknown } | string | undefined;
  const url = str(p.url) || pageUrl;
  const remote = str(p.jobLocationType).toUpperCase() === "TELECOMMUTE";
  const base = p.baseSalary as { currency?: unknown; value?: Record<string, unknown> } | undefined;
  let salary = null;
  if (base?.value) {
    const min = Number(base.value.minValue ?? base.value.value);
    const max = Number(base.value.maxValue ?? base.value.value);
    if (min > 0 && max > 0) salary = { min, max, currency: str(base.currency) || "USD", period: normalizePeriod(str(base.value.unitText)) };
  }
  const employment = Array.isArray(p.employmentType) ? p.employmentType.map(str).join(", ") : str(p.employmentType);
  return {
    externalId: (typeof ident === "object" ? str(ident?.value) : str(ident)) || url,
    company: str(org?.name) || fallbackCompany,
    title,
    location: locationOf(p) ?? (remote ? "Remote" : null),
    workplace: (remote ? "remote" : null) as Workplace | null,
    employmentType: employment || null,
    department: null,
    salary: salary ?? extractSalary(description),
    description,
    applyUrl: url,
    jobUrl: url,
    postedAt: Date.parse(str(p.datePosted)) || null,
  };
}

function candidateLinks(html: string, base: URL): string[] {
  const links = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1]!, base);
      if (u.origin !== base.origin) continue;
      if (!/job|career|position|opening|role|vacanc/i.test(u.pathname)) continue;
      if (u.pathname === base.pathname) continue;
      links.add(u.toString());
    } catch {
      /* ignore */
    }
  }
  return [...links].slice(0, MAX_DETAIL_PAGES);
}

export async function jsonLdJobs(pageUrl: string, companyName?: string | null): Promise<NormalizedJob[]> {
  const base = new URL(pageUrl);
  if (base.protocol !== "https:") throw new SourceError("Only https career pages are supported", false);
  const robots = await loadRobots(base.origin);
  if (!isAllowed(robots, base.pathname)) throw new SourceError("robots.txt disallows crawling this page", false);
  const fallback = companyName || base.hostname.replace(/^www\./, "");

  const html = await fetchHtml(base.toString());
  const postings = extractJsonLd(html).map((p) => postingToJob(p, base.toString(), fallback));
  if (postings.length === 0) {
    // Listing page without JSON-LD: visit linked job pages (allowed by robots, capped).
    const links = candidateLinks(html, base).filter((l) => isAllowed(robots, new URL(l).pathname));
    for (const link of links) {
      try {
        const page = await fetchHtml(link);
        postings.push(...extractJsonLd(page).map((p) => postingToJob(p, link, fallback)));
      } catch {
        /* skip individual page failures */
      }
    }
  }
  const jobs = postings.filter((j): j is NormalizedJob => j !== null);
  // Stable ids for postings that only expose a URL.
  for (const j of jobs) if (j.externalId.length > 64) j.externalId = (await sha256Hex(j.externalId)).slice(0, 32);
  return jobs;
}

export async function jsonLdBoard(pageUrl: string): Promise<BoardInfo> {
  const jobs = await jsonLdJobs(pageUrl);
  if (jobs.length === 0) throw new SourceError("No schema.org JobPosting data found on this page", false);
  return { companyName: jobs[0]!.company, jobCount: jobs.length };
}
