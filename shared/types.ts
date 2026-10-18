// Types shared by the Worker (API) and the React dashboard.

export type Ats = "greenhouse" | "lever" | "ashby" | "jsonld";

export type Seniority =
  | "intern"
  | "junior"
  | "mid"
  | "senior"
  | "staff"
  | "principal"
  | "manager"
  | "director"
  | "executive";

export const SENIORITY_ORDER: Seniority[] = [
  "intern",
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "manager",
  "director",
  "executive",
];

export type Workplace = "remote" | "hybrid" | "onsite";

export interface PersonalInfo {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCountry: string; // e.g. "United States"
  city: string;
  region: string;
  country: string;
  linkedin: string;
  github: string;
  website: string;
  workAuthorizedCountries: string[]; // countries the user can work in without sponsorship
  requiresSponsorship: boolean;
  willingToRelocate: boolean;
  earliestStart: string;
  noticePeriod: string;
  salaryExpectation: string;
  howDidYouHear: string;
  pronouns: string;
  // Voluntary self-identification. Empty string = leave the question unanswered,
  // "decline" = pick the "I don't wish to answer" option when present.
  eeo: { gender: string; race: string; hispanic: string; veteran: string; disability: string };
}

export interface ResumeExperience {
  id: string;
  company: string;
  title: string;
  location: string;
  start: string; // YYYY-MM
  end: string; // YYYY-MM or "" for present
  bullets: string[];
}

export interface ResumeEducation {
  id: string;
  school: string;
  degree: string;
  field: string;
  start: string;
  end: string;
  details: string[];
}

export interface ResumeProject {
  id: string;
  name: string;
  url: string;
  bullets: string[];
  skills: string[];
}

export interface BaseResume {
  headline: string;
  summary: string;
  skills: string[];
  experience: ResumeExperience[];
  education: ResumeEducation[];
  projects: ResumeProject[];
  certifications: string[];
}

/** A resume tailored to one job. Built only from BaseResume content (see worker/resume/guard.ts). */
export interface TailoredResume extends BaseResume {
  jobId: string;
  method: "ai" | "deterministic";
  matchedKeywords: string[];
  changes: string[]; // human-readable list of what was changed vs. the base resume
}

export interface Preferences {
  targetTitles: string[];
  excludeTitleKeywords: string[];
  seniority: Seniority[];
  locations: string[];
  workplace: "remote_only" | "remote_or_hybrid" | "any";
  minSalary: number | null; // annual, in salaryCurrency
  salaryCurrency: string;
  excludedCompanies: string[];
  interests: string[]; // domains / keywords the user cares about
  minScore: number; // matches below this score are not stored
  excludedLocations: string[]; // learned from "skip: location" (non-remote jobs only)
  // Learned from feedback: titles of jobs you prepared (liked) or skipped for the role (disliked).
  learned: { liked: string[]; disliked: string[] };
}

export interface UserSettings {
  monthlyBudgetUsd: number;
  aiEnabled: boolean;
  autoShortlistScore: number; // 0 = off
  autoPrepare: boolean;
  autoPrepareDailyLimit: number;
  liveSubmitEnabled: boolean;
  digestEnabled: boolean;
}

export type Locale = "vi" | "en";
export type SkipReason = "company" | "role" | "location" | "salary" | "other";

export interface CatalogCompany {
  name: string;
  ats: Exclude<Ats, "jsonld">;
  token: string;
  category: string;
}

export type AppStatus =
  | "shortlisted"
  | "preparing"
  | "prepared"
  | "approved"
  | "submitting"
  | "submitted"
  | "needs_manual"
  | "failed"
  | "interview"
  | "rejected"
  | "offered"
  | "withdrawn";

export const QUEUE_STATUSES: AppStatus[] = [
  "shortlisted",
  "preparing",
  "prepared",
  "approved",
  "submitting",
  "needs_manual",
  "failed",
];

export const TRACKER_STATUSES: AppStatus[] = [
  "shortlisted",
  "prepared",
  "submitted",
  "interview",
  "offered",
  "rejected",
];

export interface JobAnalysis {
  requiredSkills: string[];
  niceToHaveSkills: string[];
  minYears: number | null;
  seniority: Seniority | null;
  workplace: Workplace | null;
  visaSponsorship: "yes" | "no" | "unknown";
  salary: { min: number; max: number; currency: string; period: string } | null;
  keywords: string[];
  summary: string;
}

export interface MatchBreakdown {
  skills: number;
  /** Semantic resume↔job similarity (embeddings); null when unavailable. Older matches lack it. */
  semantic?: number | null;
  title: number;
  experience?: number;
  seniority: number;
  location: number;
  salary: number;
}

export interface MatchReasons {
  matchedSkills: string[];
  missingSkills: string[];
  flags: string[];
  breakdown: MatchBreakdown;
  analysis: "heuristic" | "ai";
  rationale?: string;
  concerns?: string[];
}

export type FieldType = "text" | "textarea" | "select" | "multiselect" | "file" | "location" | "date";

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: { label: string; value: string }[];
  description: string;
  section: "main" | "compliance";
}

export interface PreparedAnswer {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  value: string | string[];
  source: "profile" | "library" | "ai" | "default" | "user" | "file" | "none";
  needsReview: boolean;
  note?: string;
}

export interface UsageSummary {
  month: string;
  budgetUsd: number;
  spentUsd: number;
  calls: number;
  cacheHits: number;
  blocked: number;
  mode: "normal" | "conserve" | "essential" | "exhausted" | "disabled";
}
