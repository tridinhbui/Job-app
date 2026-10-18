import type { MatchReasons } from "../shared/types";
import { fmtSalary } from "./api";

type T = (vi: string, en: string) => string;

/** One-line, plain-language reason for a match score, e.g. "Hợp 8/10 kỹ năng · Remote · tới $250k". */
export function scoreSummary(
  t: T,
  reasons: MatchReasons | null,
  job: { workplace?: string | null; salary_min?: number | null; salary_max?: number | null; salary_currency?: string | null; salary_period?: string | null },
): string {
  const parts: string[] = [];
  if (reasons) {
    const total = reasons.matchedSkills.length + reasons.missingSkills.length;
    if (total) parts.push(t(`Hợp ${reasons.matchedSkills.length}/${total} kỹ năng`, `${reasons.matchedSkills.length}/${total} skills match`));
  }
  if (job.workplace === "remote") parts.push("Remote");
  else if (job.workplace === "hybrid") parts.push("Hybrid");
  const salary = fmtSalary(job.salary_min ?? null, job.salary_max ?? null, job.salary_currency ?? null, job.salary_period ?? null);
  if (salary) parts.push(salary);
  return parts.join(" · ");
}
