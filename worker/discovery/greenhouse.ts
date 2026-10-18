import type { Workplace } from "../../shared/types";
import { htmlToText } from "../lib/util";
import { extractSalary } from "./salary";
import { type BoardInfo, fetchJson, type NormalizedJob } from "./types";

interface GhJob {
  id: number | string;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  company_name?: string;
  location?: { name?: string };
  content?: string;
  metadata?: { name: string; value: unknown }[] | null;
  departments?: { name: string }[];
}

const API = "https://boards-api.greenhouse.io/v1/boards";

function workplaceOf(job: GhJob): Workplace | null {
  const meta = job.metadata?.find((m) => /location type|workplace|remote/i.test(m.name));
  const v = `${typeof meta?.value === "string" ? meta.value : ""} ${job.location?.name ?? ""}`.toLowerCase();
  if (/remote/.test(v)) return "remote";
  if (/hybrid/.test(v)) return "hybrid";
  if (/on-?site|in[- ]office/.test(v)) return "onsite";
  return null;
}

export async function greenhouseBoard(token: string): Promise<BoardInfo> {
  const board = await fetchJson<{ name?: string }>(`${API}/${encodeURIComponent(token)}`);
  const jobs = await fetchJson<{ meta?: { total?: number } }>(`${API}/${encodeURIComponent(token)}/jobs`);
  return { companyName: board.name ?? token, jobCount: jobs.meta?.total ?? 0 };
}

export async function greenhouseJobs(token: string, companyName?: string | null): Promise<NormalizedJob[]> {
  const data = await fetchJson<{ jobs: GhJob[] }>(`${API}/${encodeURIComponent(token)}/jobs?content=true`);
  return data.jobs.map((j) => {
    const description = htmlToText(j.content ?? "");
    const id = String(j.id);
    return {
      externalId: id,
      company: j.company_name || companyName || token,
      title: j.title.trim(),
      location: j.location?.name?.trim() || null,
      workplace: workplaceOf(j),
      employmentType: null,
      department: j.departments?.[0]?.name ?? null,
      salary: extractSalary(description),
      description,
      // The embedded form works for every Greenhouse board, including those whose
      // absolute_url points at a custom careers domain.
      applyUrl: `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${id}`,
      jobUrl: j.absolute_url,
      postedAt: Date.parse(j.first_published ?? j.updated_at ?? "") || null,
    };
  });
}
