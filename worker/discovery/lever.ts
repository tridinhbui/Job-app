import type { Workplace } from "../../shared/types";
import { htmlToText } from "../lib/util";
import { extractSalary, normalizePeriod } from "./salary";
import { type BoardInfo, fetchJson, type NormalizedJob } from "./types";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl: string;
  createdAt?: number;
  workplaceType?: string;
  descriptionPlain?: string;
  additionalPlain?: string;
  lists?: { text: string; content: string }[];
  categories?: { location?: string; team?: string; commitment?: string; department?: string };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

const API = "https://api.lever.co/v0/postings";

const WORKPLACE: Record<string, Workplace> = { remote: "remote", hybrid: "hybrid", "on-site": "onsite", onsite: "onsite" };

export async function leverBoard(token: string): Promise<BoardInfo> {
  const data = await fetchJson<LeverPosting[]>(`${API}/${encodeURIComponent(token)}?mode=json&limit=1`);
  return { companyName: token.charAt(0).toUpperCase() + token.slice(1), jobCount: Array.isArray(data) ? data.length : 0 };
}

export async function leverJobs(token: string, companyName?: string | null): Promise<NormalizedJob[]> {
  const data = await fetchJson<LeverPosting[]>(`${API}/${encodeURIComponent(token)}?mode=json`);
  return data.map((p) => {
    const lists = (p.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n\n");
    const description = [p.descriptionPlain ?? "", lists, p.additionalPlain ?? ""].filter(Boolean).join("\n\n").trim();
    const sr = p.salaryRange;
    const salary =
      sr?.min && sr.max
        ? { min: sr.min, max: sr.max, currency: sr.currency ?? "USD", period: normalizePeriod(sr.interval) }
        : extractSalary(description);
    return {
      externalId: p.id,
      company: companyName || token,
      title: p.text.trim(),
      location: p.categories?.location ?? null,
      workplace: WORKPLACE[(p.workplaceType ?? "").toLowerCase()] ?? null,
      employmentType: p.categories?.commitment ?? null,
      department: p.categories?.team ?? p.categories?.department ?? null,
      salary,
      description,
      applyUrl: p.applyUrl,
      jobUrl: p.hostedUrl,
      postedAt: p.createdAt ?? null,
    };
  });
}
