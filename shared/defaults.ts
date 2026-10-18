import type { BaseResume, PersonalInfo, Preferences, UserSettings } from "./types";

export const emptyPersonal = (): PersonalInfo => ({
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  phoneCountry: "",
  city: "",
  region: "",
  country: "",
  linkedin: "",
  github: "",
  website: "",
  workAuthorizedCountries: [],
  requiresSponsorship: false,
  willingToRelocate: false,
  earliestStart: "",
  noticePeriod: "",
  salaryExpectation: "",
  howDidYouHear: "",
  pronouns: "",
  eeo: { gender: "", race: "", hispanic: "", veteran: "", disability: "" },
});

export const emptyResume = (): BaseResume => ({
  headline: "",
  summary: "",
  skills: [],
  experience: [],
  education: [],
  projects: [],
  certifications: [],
});

export const defaultPreferences = (): Preferences => ({
  targetTitles: [],
  excludeTitleKeywords: [],
  seniority: [],
  locations: [],
  workplace: "any",
  minSalary: null,
  salaryCurrency: "USD",
  excludedCompanies: [],
  interests: [],
  minScore: 40,
});

export const defaultSettings = (budgetUsd = 10): UserSettings => ({
  monthlyBudgetUsd: budgetUsd,
  aiEnabled: true,
  autoShortlistScore: 0,
  autoPrepare: false,
  autoPrepareDailyLimit: 5,
  liveSubmitEnabled: false,
});

/** Merge a stored (possibly older / partial) object over defaults so new fields always exist. */
export function withDefaults<T extends object>(defaults: T, stored: unknown): T {
  if (!stored || typeof stored !== "object") return defaults;
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!(k in defaults) || v === undefined) continue;
    const d = (defaults as Record<string, unknown>)[k];
    out[k] =
      d && typeof d === "object" && !Array.isArray(d) && v && typeof v === "object" && !Array.isArray(v)
        ? withDefaults(d as object, v)
        : v;
  }
  return out as T;
}
