import type { BaseResume, FormField, PersonalInfo, PreparedAnswer } from "../../shared/types";
import type { SavedAnswer } from "../db/profile";
import { locationMatches, totalYears } from "../matching/score";
import { tokenize } from "../matching/skills";

// Deterministic answer engine. Handles the bulk of application questions from saved profile
// data and the user's answer library; only unresolved required questions go to AI.

export interface AnswerContext {
  personal: PersonalInfo;
  resume: BaseResume;
  library: SavedAnswer[];
  job: { company: string; title: string; location: string | null };
}

const ATTESTATION = /\b(acknowledge|certify|attest|consent|agree|i understand|confirm that|confirm your|privacy (policy|notice)|terms)\b/i;

const yes = (b: boolean) => (b ? "Yes" : "No");

// Facts about the candidate's history/circumstances that neither the profile nor AI can know.
const PERSONAL_FACT =
  /\b(have you (ever )?(previously )?(worked|interviewed|applied|been (employed|contracted))|previously (worked|applied|employed)|ever been employed|related to (anyone|an employee)|relatives?|criminal|convicted|non-?compete|non-?solicit|who referred|referred by|security clearance|clearance)\b/i;
// Preferences/commitments the user must state themselves unless saved in the answer library.
const PREFERENCE = /^\s*(are you (open|willing|able|comfortable)|would you (be )?(open|willing|able|comfortable)|can you (commit|work|travel)|do you agree|are you available)/i;
const YES_NO_QUESTION = /^\s*(are|do|does|will|would|have|has|can|is)\b/i;

export function chooseOption(options: FormField["options"], desired: string): string | null {
  const d = desired.trim().toLowerCase();
  if (!d) return null;
  const exact = options.find((o) => o.label.trim().toLowerCase() === d);
  if (exact) return exact.label;
  if (d === "yes" || d === "no") {
    const yn = options.find((o) => new RegExp(`^${d}\\b`, "i").test(o.label.trim()));
    if (yn) return yn.label;
  }
  const partial = options.filter((o) => o.label.toLowerCase().includes(d) || d.includes(o.label.toLowerCase()));
  return partial.length === 1 ? partial[0]!.label : null;
}

const DECLINE = /decline|don.?t wish|do not wish|prefer not|not to (say|answer|disclose)|choose not/i;

function eeoValue(field: FormField, pref: string): string | null {
  if (!pref) return null;
  if (pref === "decline") return field.options.find((o) => DECLINE.test(o.label))?.label ?? null;
  return chooseOption(field.options, pref);
}

export function normalizeQuestion(label: string): string {
  return tokenize(label).filter((t) => t.length > 2).join(" ");
}

function libraryAnswer(label: string, library: SavedAnswer[]): string | null {
  const q = new Set(normalizeQuestion(label).split(" "));
  if (q.size === 0) return null;
  let best: { score: number; answer: string } | null = null;
  for (const a of library) {
    const t = new Set(normalizeQuestion(a.question).split(" "));
    let inter = 0;
    for (const w of q) if (t.has(w)) inter++;
    const score = inter / (q.size + t.size - inter);
    if (score >= 0.8 && (!best || score > best.score)) best = { score, answer: a.answer };
  }
  return best?.answer ?? null;
}

function yearsBucket(field: FormField, years: number): string | null {
  for (const o of field.options) {
    const nums = (o.label.match(/\d+/g) ?? []).map(Number);
    if (/less than|under|<\s*\d/i.test(o.label) && nums[0] != null && years < nums[0]) return o.label;
    if (/\+|or more|more than|over/i.test(o.label) && nums[0] != null && years >= nums[0]) return o.label;
    if (nums.length === 2 && years >= nums[0]! && years <= nums[1]!) return o.label;
  }
  return null;
}

/** Map a work-authorization question to Yes/No only when the profile makes it unambiguous. */
function workAuth(label: string, ctx: AnswerContext): string | null {
  const countries = ctx.personal.workAuthorizedCountries.map((c) => c.toLowerCase());
  if (!countries.length) return null;
  const l = label.toLowerCase();
  const alias = (c: string) => (c === "united states" ? ["united states", "u.s.", "us ", "usa"] : c === "united kingdom" ? ["united kingdom", "uk"] : [c]);
  if (countries.some((c) => alias(c).some((a) => l.includes(a)))) return "Yes";
  const mentionsCountry = /(united states|u\.s\.|usa|canada|united kingdom|\buk\b|germany|france|india|australia|ireland|netherlands|singapore|japan|country)/i.test(label);
  // "...in the country where the job is located": answer from the job's location.
  if (/country/i.test(label) && ctx.job.location && locationMatches(ctx.job.location, countries)) return "Yes";
  if (mentionsCountry) return null;
  return null;
}

function current(resume: BaseResume) {
  return resume.experience.find((e) => !e.end) ?? resume.experience[0];
}

/** Returns a deterministic answer for a field, or null if it cannot be answered safely. */
function deterministic(field: FormField, ctx: AnswerContext): Omit<PreparedAnswer, "key" | "label" | "type" | "required"> | null {
  const p = ctx.personal;
  const L = field.label;
  const profile = (value: string, needsReview = false) => (value ? { value, source: "profile" as const, needsReview } : null);
  const select = (desired: string | null, needsReview = false) => {
    if (!desired) return null;
    const v = field.options.length ? chooseOption(field.options, desired) : desired;
    return v ? { value: v, source: "profile" as const, needsReview } : null;
  };
  const eeo = (f: FormField, pref: string) => {
    const v = eeoValue(f, pref);
    return v ? { value: v, source: "profile" as const, needsReview: false } : null;
  };

  const fullName = `${p.firstName} ${p.lastName}`.trim();
  const locationText = [p.city, p.region, p.country].filter(Boolean).join(", ");
  switch (field.key) {
    // Ashby system fields / Lever standard fields
    case "_systemfield_name":
    case "name":
      return profile(fullName);
    case "_systemfield_email":
      return profile(p.email);
    case "_systemfield_resume":
      return { value: "Tailored resume (PDF)", source: "file", needsReview: false };
    case "_systemfield_location":
      return profile(locationText);
    case "org":
      return profile(current(ctx.resume)?.company ?? "");
    case "comments":
      return null;
    case "first_name":
      return profile(p.firstName);
    case "last_name":
      return profile(p.lastName);
    case "email":
      return profile(p.email);
    case "phone":
      return profile(p.phone);
    case "resume":
      return { value: "Tailored resume (PDF)", source: "file", needsReview: false };
    case "cover_letter":
      return null;
    case "location":
      return profile([p.city, p.region, p.country].filter(Boolean).join(", "));
    case "gender":
      return eeo(field, p.eeo.gender);
    case "race":
      return eeo(field, p.eeo.race);
    case "hispanic_ethnicity":
      return eeo(field, p.eeo.hispanic);
    case "veteran_status":
      return eeo(field, p.eeo.veteran);
    case "disability_status":
      return eeo(field, p.eeo.disability);
  }
  if (field.section === "compliance") {
    if (/gender/i.test(L)) return eeo(field, p.eeo.gender);
    if (/race|ethnic/i.test(L)) return eeo(field, /hispanic|latino/i.test(L) ? p.eeo.hispanic : p.eeo.race);
    if (/veteran/i.test(L)) return eeo(field, p.eeo.veteran);
    if (/disab/i.test(L)) return eeo(field, p.eeo.disability);
    return null;
  }

  const lib = libraryAnswer(L, ctx.library);
  if (lib) {
    const v = field.options.length ? chooseOption(field.options, lib) : lib;
    if (v) return { value: v, source: "library", needsReview: false };
  }
  if (ATTESTATION.test(L) || ATTESTATION.test(field.description)) return null; // the user must answer attestations themselves
  if (field.type === "date") return null; // dates (e.g. start date) are personal — the user picks one
  if (field.type === "file") return null;

  if (/^(full |legal )?name$/i.test(L.trim())) return profile(fullName);
  if (/^e-?mail( address)?$/i.test(L.trim())) return profile(p.email);
  if (/\bphone\b/i.test(L) && !field.options.length) return profile(p.phone);

  if (/linkedin/i.test(L)) return profile(p.linkedin);
  if (/github/i.test(L)) return profile(p.github);
  if (/website|portfolio|personal (site|url)|blog/i.test(L)) return profile(p.website || p.github);
  if (/twitter|x\.com/i.test(L)) return null;
  if (/\baddress\b|where (do|will) you (plan|intend) to work|location (from which|you will work)/i.test(L) && !field.options.length) {
    return profile([p.city, p.region, p.country].filter(Boolean).join(", "), true);
  }
  const yesNo = field.options.length > 0 || YES_NO_QUESTION.test(L);
  if (/sponsor/i.test(L) && yesNo) return select(yes(p.requiresSponsorship));
  if (/(authori[sz]ed|eligible|legally|right) to work|work authori[sz]ation|work permit/i.test(L)) return select(workAuth(L, ctx), true);
  if (/relocat/i.test(L) && yesNo) return select(yes(p.willingToRelocate));
  if (/earliest|start date|when can you start|available to start|availability/i.test(L)) return profile(p.earliestStart);
  if (/notice period/i.test(L)) return profile(p.noticePeriod);
  if (/salary|compensation|pay expectation|expected pay|desired pay/i.test(L)) return field.options.length ? null : profile(p.salaryExpectation, true);
  if (/how did you (hear|find|learn)|where did you (hear|find|see)|referr(al|ed) source/i.test(L)) return select(p.howDidYouHear);
  if (/pronoun/i.test(L)) return select(p.pronouns);
  if (/preferred (first )?name/i.test(L)) return profile(p.firstName);
  const cur = current(ctx.resume);
  if (/current (company|employer)|most recent (company|employer)/i.test(L)) return profile(cur?.company ?? "");
  if (/current (job )?(title|role|position)/i.test(L)) return profile(cur?.title ?? "");
  if (/years of .{0,40}experience|years.{0,20}experience do you have/i.test(L)) {
    const years = totalYears(ctx.resume);
    if (field.options.length) {
      const b = yearsBucket(field, years);
      return b ? { value: b, source: "profile", needsReview: true } : null;
    }
    return { value: String(Math.floor(years)), source: "profile", needsReview: true };
  }
  if (/(where are you|current(ly)?) (located|based)|^city|current location|^location/i.test(L) && !field.options.length) {
    return profile([p.city, p.region, p.country].filter(Boolean).join(", "));
  }
  return null;
}

export function prepareDeterministicAnswers(fields: FormField[], ctx: AnswerContext): { answers: PreparedAnswer[]; needsAi: FormField[] } {
  const answers: PreparedAnswer[] = [];
  const needsAi: FormField[] = [];
  for (const f of fields) {
    const base = { key: f.key, label: f.label, type: f.type, required: f.required };
    const d = deterministic(f, ctx);
    if (d) {
      answers.push({ ...base, ...d });
      continue;
    }
    const attestation = ATTESTATION.test(f.label) || ATTESTATION.test(f.description);
    const personalFact = PERSONAL_FACT.test(f.label);
    const preference = PREFERENCE.test(f.label);
    // AI only drafts open-ended text answers (motivation, experience descriptions) for
    // required questions. Choices about facts, preferences or legal terms stay with the user.
    const openEnded = f.type === "textarea" || (f.type === "text" && !f.options.length);
    if (f.required && openEnded && !attestation && !personalFact && !preference && f.section === "main") needsAi.push(f);
    const note = attestation
      ? "Attestation — please answer this yourself"
      : personalFact || preference
        ? "Personal answer — only you can answer this (it will be remembered if you save it)"
        : f.type === "date"
          ? "Pick a date (YYYY-MM-DD)"
          : f.type === "file"
            ? "Upload not supported automatically"
            : undefined;
    answers.push({
      ...base,
      value: f.type === "multiselect" ? [] : "",
      source: "none",
      needsReview: f.required,
      note,
    });
  }
  return { answers, needsAi };
}

export function missingRequired(answers: PreparedAnswer[]): string[] {
  return answers
    .filter((a) => a.required && (Array.isArray(a.value) ? a.value.length === 0 : !a.value.trim()))
    .map((a) => a.label);
}
