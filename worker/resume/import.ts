import { emptyResume } from "../../shared/defaults";
import type { BaseResume } from "../../shared/types";
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

  const ai = await aiStructureResume(env, userId, text);
  if (!ai.ok) return { draft: null, text, method: "text-only", note: ai.message };

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
  return { draft, text, method: "ai", note: "Review every field before saving — imported text is copied verbatim but may be mis-sectioned." };
}
