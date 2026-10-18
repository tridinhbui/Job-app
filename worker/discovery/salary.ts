import type { Salary } from "./types";

const CURRENCY_SYMBOLS: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR", "C$": "CAD", "A$": "AUD" };

function parseAmount(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, "").toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  let n = parseFloat(m[1]!);
  if (m[2] === "k") n *= 1_000;
  if (m[2] === "m") n *= 1_000_000;
  return Math.round(n);
}

export function normalizePeriod(raw: string | null | undefined): Salary["period"] {
  const s = (raw ?? "").toLowerCase();
  if (/hour|hr/.test(s)) return "hour";
  if (/month/.test(s)) return "month";
  return "year";
}

/**
 * Extract a salary range from free text, e.g. "$180,000 - $220,000", "£70k–£90k", "USD 150K to 190K".
 * Returns the first plausible range. Deterministic; no AI.
 */
export function extractSalary(text: string): Salary | null {
  const re =
    /(C\$|A\$|\$|£|€|USD|EUR|GBP|CAD|AUD)\s?(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?\s?[kKmM]?)\s*(?:-|–|—|to)\s*(?:C\$|A\$|\$|£|€|USD|EUR|GBP|CAD|AUD)?\s?(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?\s?[kKmM]?)(?:\s*(?:USD|EUR|GBP|CAD|AUD))?([^\n]{0,40})/g;
  for (const m of text.matchAll(re)) {
    const sym = m[1]!;
    const currency = CURRENCY_SYMBOLS[sym] ?? sym.toUpperCase();
    // "160.000" style thousands separators
    let a = parseAmount(m[2]!.replace(/\.(\d{3})/g, "$1"));
    let b = parseAmount(m[3]!.replace(/\.(\d{3})/g, "$1"));
    if (a == null || b == null) continue;
    // "$150-190K" -> both thousands
    if (/[kK]/.test(m[3]!) && !/[kKmM]/.test(m[2]!) && a < 1000) a *= 1000;
    if (a > b) [a, b] = [b, a];
    const tail = m[4] ?? "";
    let period: Salary["period"] = /hour|hr\b|\/h\b/i.test(tail) ? "hour" : /month|\/mo\b/i.test(tail) ? "month" : "year";
    if (period === "year" && b < 1000) period = "hour";
    if (period === "year" && (a < 10_000 || b > 5_000_000)) continue;
    if (period === "hour" && b > 1000) continue;
    return { min: a, max: b, currency, period };
  }
  return null;
}

/** Annualize for comparison against a user's minimum (approximate: 2080 h/yr). */
export function annualize(s: Pick<Salary, "min" | "max" | "period">): { min: number; max: number } {
  const f = s.period === "hour" ? 2080 : s.period === "month" ? 12 : 1;
  return { min: s.min * f, max: s.max * f };
}
