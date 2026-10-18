import type { Workplace } from "../../shared/types";
import { htmlToText } from "../lib/util";
import { extractSalary, normalizePeriod } from "./salary";
import { type BoardInfo, fetchJson, type NormalizedJob, type Salary } from "./types";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  department?: string;
  team?: string;
  employmentType?: string;
  isListed?: boolean;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  publishedAt?: string;
  jobUrl: string;
  applyUrl: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: {
    summaryComponents?: {
      compensationType: string;
      interval?: string;
      currencyCode?: string;
      minValue?: number | null;
      maxValue?: number | null;
    }[];
  };
}

const API = "https://api.ashbyhq.com/posting-api/job-board";

function workplaceOf(j: AshbyJob): Workplace | null {
  const w = (j.workplaceType ?? "").toLowerCase();
  if (w === "remote" || j.isRemote) return "remote";
  if (w === "hybrid") return "hybrid";
  if (w === "onsite") return "onsite";
  return null;
}

function salaryOf(j: AshbyJob, description: string): Salary | null {
  const c = j.compensation?.summaryComponents?.find((s) => s.compensationType === "Salary" && s.minValue && s.maxValue);
  if (c?.minValue && c.maxValue) {
    return { min: c.minValue, max: c.maxValue, currency: c.currencyCode ?? "USD", period: normalizePeriod(c.interval) };
  }
  return extractSalary(description);
}

export async function ashbyBoard(token: string): Promise<BoardInfo> {
  const data = await fetchJson<{ jobs: AshbyJob[] }>(`${API}/${encodeURIComponent(token)}`);
  return { companyName: token.charAt(0).toUpperCase() + token.slice(1), jobCount: data.jobs?.length ?? 0 };
}

export async function ashbyJobs(token: string, companyName?: string | null): Promise<NormalizedJob[]> {
  const data = await fetchJson<{ jobs: AshbyJob[] }>(`${API}/${encodeURIComponent(token)}?includeCompensation=true`);
  return data.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const description = j.descriptionPlain?.trim() || htmlToText(j.descriptionHtml ?? "");
      const locations = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean);
      return {
        externalId: j.id,
        company: companyName || token,
        title: j.title.trim(),
        location: locations.join("; ") || null,
        workplace: workplaceOf(j),
        employmentType: j.employmentType ?? null,
        department: j.department ?? j.team ?? null,
        salary: salaryOf(j, description),
        description,
        applyUrl: j.applyUrl,
        jobUrl: j.jobUrl,
        postedAt: Date.parse(j.publishedAt ?? "") || null,
      };
    });
}
