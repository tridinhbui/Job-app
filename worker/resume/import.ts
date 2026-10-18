import { emptyResume } from "../../shared/defaults";
import type { BaseResume, PersonalInfo, Seniority } from "../../shared/types";
import { inferSeniority, totalYears } from "../matching/score";
import { aiStructureResume } from "../ai/tasks";
import type { Env } from "../env";
import { putPrivate, userKey } from "../lib/storage";
import { HttpError, uuid } from "../lib/util";

const ALLOWED = /\.(pdf|docx|txt|md)$/i;
const MAX_BYTES = 5 * 1024 * 1024;

export interface ImportResult {
  draft: BaseResume | null; // structured draft for the user to review (never auto-saved)
  text: string; // extracted text, always returned so the user can copy from it
  method: "ai" | "text-only";
  note?: string;
  contact: Partial<PersonalInfo>; // contact details found in the document
  suggested: { targetTitles: string[]; seniority: Seniority[]; years: number } | null;
}

/**
 * Deterministic contact extraction from resume text (free, no AI). Only returns what is
 * literally present in the document.
 */
export function extractContact(text: string): Partial<PersonalInfo> {
  const head = text.slice(0, 1500);
  const out: Partial<PersonalInfo> = {};
  const email = head.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (email) out.email = email[0];
  const phone = head.match(/(\+?\(?\d[\d\s().-]{7,}\d)/);
  if (phone && phone[1]!.replace(/\D/g, "").length >= 9) out.phone = phone[1]!.trim();
  const linkedin = head.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[\w%-]+\/?/i);
  if (linkedin) out.linkedin = linkedin[0].startsWith("http") ? linkedin[0] : `https://${linkedin[0]}`;
  const github = head.match(/(?:https?:\/\/)?github\.com\/[\w-]+\/?/i);
  if (github) out.github = github[0].startsWith("http") ? github[0] : `https://${github[0]}`;
  // Name: first short line made only of capitalised words.
  for (const line of head.split("\n").slice(0, 6)) {
    const l = line.replace(/^[#*\s]+|[*\s]+$/g, "");
    if (/^(\p{Lu}[\p{L}'-]+)(\s+\p{Lu}[\p{L}'.-]*){1,3}$/u.test(l)) {
      const parts = l.split(/\s+/);
      out.firstName = parts[0];
      out.lastName = parts.slice(1).join(" ");
      break;
    }
  }
  // Location like "San Francisco, CA" or "Hanoi, Vietnam" on a contact line.
  const loc = head.match(/(?:^|[|•·\n]\s*)([A-Z][a-zA-Z .'-]{2,30}),\s*([A-Z]{2}|[A-Z][a-zA-Z ]{3,30})(?=\s*(?:[|•·\n]|$))/m);
  if (loc) {
    out.city = loc[1]!.trim();
    if (/^[A-Z]{2}$/.test(loc[2]!)) {
      out.region = loc[2];
      out.country = "United States";
    } else out.country = loc[2]!.trim();
  }
  return out;
}

export function suggestPreferences(resume: BaseResume): ImportResult["suggested"] {
  if (!resume.experience.length) return null;
  const years = totalYears(resume);
  const titles = [...new Set(resume.experience.slice(0, 3).map((e) => e.title.trim()).filter(Boolean))].slice(0, 2);
  return { targetTitles: titles, seniority: [inferSeniority(years)], years };
}

/** Normalize "Jan 2021", "2021-01", "01/2021", "2021" -> "YYYY-MM" | "YYYY". */
export function normalizeDate(s: string): string {
  const t = s.trim().toLowerCase();
  if (!t || /present|current|now/.test(t)) return "";
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let m = t.match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})\/(\d{4})/);
  if (m) return `${m[2]}-${m[1]!.padStart(2, "0")}`;
  m = t.match(/([a-z]{3})[a-z]*\.?\s+(\d{4})/);
  if (m && months.includes(m[1]!)) return `${m[2]}-${String(months.indexOf(m[1]!) + 1).padStart(2, "0")}`;
  m = t.match(/(\d{4})/);
  return m ? m[1]! : "";
}

export async function importResume(env: Env, userId: string, file: File): Promise<ImportResult> {
  if (!ALLOWED.test(file.name)) throw new HttpError(400, "Upload a PDF, DOCX, TXT or MD file");
  if (file.size > MAX_BYTES) throw new HttpError(400, "File is larger than 5 MB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  await putPrivate(env, userKey(userId, `uploads/${uuid()}-${file.name.replace(/[^\w.-]/g, "_")}`), bytes, file.type || "application/octet-stream");

  let text: string;
  if (/\.(txt|md)$/i.test(file.name)) text = new TextDecoder().decode(bytes);
  else {
    // Workers AI document conversion (no LLM tokens for PDF/DOCX).
    const res = await env.AI.toMarkdown({ name: file.name, blob: new Blob([bytes], { type: file.type }) });
    if (res.format === "error") throw new HttpError(422, `Could not read the document: ${res.error}`);
    text = res.data;
  }
  text = text.trim();
  if (text.length < 50) throw new HttpError(422, "The document appears to contain no extractable text (scanned image?)");

  const contact = extractContact(text);
  const ai = await aiStructureResume(env, userId, text);
  if (!ai.ok) return { draft: null, text, method: "text-only", note: ai.message, contact, suggested: null };

  const d = ai.data;
  const draft: BaseResume = {
    ...emptyResume(),
    headline: d.headline,
    summary: d.summary,
    skills: [...new Set(d.skills)],
    experience: d.experience
      .filter((e) => e.company || e.title)
      .map((e) => ({ id: uuid().slice(0, 8), company: e.company, title: e.title, location: e.location, start: normalizeDate(e.start), end: normalizeDate(e.end), bullets: e.bullets })),
    education: d.education
      .filter((e) => e.school)
      .map((e) => ({ id: uuid().slice(0, 8), school: e.school, degree: e.degree, field: e.field, start: normalizeDate(e.start), end: normalizeDate(e.end), details: [] })),
    projects: d.projects.filter((p) => p.name).map((p) => ({ id: uuid().slice(0, 8), name: p.name, url: p.url, bullets: p.bullets, skills: [] })),
    certifications: d.certifications,
  };
  return {
    draft,
    text,
    method: "ai",
    note: "Review every field before saving — imported text is copied verbatim but may be mis-sectioned.",
    contact,
    suggested: suggestPreferences(draft),
  };
}
