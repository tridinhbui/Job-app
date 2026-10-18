import type { Workplace } from "../../shared/types";

export interface Salary {
  min: number;
  max: number;
  currency: string;
  period: "year" | "month" | "hour";
}

/** Job as returned by an ATS adapter, before ApplyPilot-specific enrichment. */
export interface NormalizedJob {
  externalId: string;
  company: string;
  title: string;
  location: string | null;
  workplace: Workplace | null;
  employmentType: string | null;
  department: string | null;
  salary: Salary | null;
  description: string; // plain text
  applyUrl: string;
  jobUrl: string;
  postedAt: number | null;
}

export interface BoardInfo {
  companyName: string;
  jobCount: number;
}

export class SourceError extends Error {
  constructor(
    message: string,
    /** false for permanent problems (404 board, robots disallow) — do not retry. */
    public retryable: boolean,
  ) {
    super(message);
  }
}

export const USER_AGENT = "ApplyPilotBot/0.1 (+personal job-search agent; respects robots.txt)";

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (res.status === 404) throw new SourceError(`Board not found (404): ${url}`, false);
  if (res.status === 429 || res.status >= 500) throw new SourceError(`Upstream ${res.status}: ${url}`, true);
  if (!res.ok) throw new SourceError(`Upstream ${res.status}: ${url}`, false);
  return (await res.json()) as T;
}
