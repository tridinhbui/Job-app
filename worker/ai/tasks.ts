import { z } from "zod";
import { SENIORITY_ORDER, type BaseResume, type FormField, type JobAnalysis, type Seniority } from "../../shared/types";
import type { Env } from "../env";
import { truncate } from "../lib/util";
import { runJson, type AiResult } from "./client";

// Prompts are short and fact-bound: the model only ever sees data the user supplied
// (resume/profile) plus the job description, and is told to never invent facts.

const strArr = (max: number) =>
  z
    .array(z.string())
    .catch([])
    .transform((a) => a.map((s) => s.trim()).filter(Boolean).slice(0, max));

// ---------------- JD analysis (fast model, cached per job content hash) ----------------

const JdSchema = z.object({
  requiredSkills: strArr(20),
  niceToHaveSkills: strArr(12),
  minYears: z.coerce.number().int().min(0).max(30).nullable().catch(null),
  seniority: z.enum(SENIORITY_ORDER as [Seniority, ...Seniority[]]).nullable().catch(null),
  workplace: z.enum(["remote", "hybrid", "onsite"]).nullable().catch(null),
  visaSponsorship: z.enum(["yes", "no", "unknown"]).catch("unknown"),
  summary: z.string().catch("").transform((s) => truncate(s, 400)),
});

export async function aiAnalyzeJob(
  env: Env,
  userId: string,
  job: { title: string; company: string; location: string | null; description: string },
): Promise<AiResult<Omit<JobAnalysis, "salary" | "keywords">>> {
  return runJson(env, {
    userId,
    task: "jd_analysis",
    model: env.AI_MODEL_FAST,
    maxTokens: 450,
    schema: JdSchema,
    system:
      "You extract structured facts from a job posting. Respond with ONLY a JSON object with keys: " +
      'requiredSkills (string[], concrete skills/technologies/tools that are required, short canonical names like "Python", "Kubernetes", "B2B Sales"), ' +
      "niceToHaveSkills (string[], preferred/bonus skills), minYears (number|null, minimum years of experience required), " +
      `seniority (one of ${SENIORITY_ORDER.join("|")} or null), workplace ("remote"|"hybrid"|"onsite"|null), ` +
      'visaSponsorship ("yes" if the posting says it sponsors visas, "no" if it says it does not or requires authorization without sponsorship, otherwise "unknown"), ' +
      "summary (max 40 words, what the role does). Do not guess: use null/unknown/[] when the posting does not say.",
    user: `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location ?? "n/a"}\n\n${truncate(job.description, 9000)}`,
  });
}

// ---------------- Match reasoning for ambiguous scores (fast model) ----------------

const MatchSchema = z.object({
  score: z.coerce.number().min(0).max(100).transform(Math.round),
  rationale: z.string().catch("").transform((s) => truncate(s, 300)),
  concerns: strArr(3),
});

export async function aiMatchReasoning(
  env: Env,
  userId: string,
  candidate: string,
  job: { title: string; company: string; analysis: JobAnalysis },
): Promise<AiResult<z.infer<typeof MatchSchema>>> {
  return runJson(env, {
    userId,
    task: "match_reasoning",
    model: env.AI_MODEL_FAST,
    maxTokens: 220,
    schema: MatchSchema,
    system:
      "You are a strict, honest recruiter. Rate how well the candidate fits the job from 0 to 100 " +
      "(90+: clearly qualified, 70-89: good fit, 50-69: partial, <50: poor). Judge only on the facts given. " +
      'Respond with ONLY JSON: {"score": number, "rationale": string (max 35 words), "concerns": string[] (max 3)}.',
    user:
      `CANDIDATE\n${candidate}\n\nJOB: ${job.title} at ${job.company}\n` +
      `Seniority: ${job.analysis.seniority ?? "n/a"}; min years: ${job.analysis.minYears ?? "n/a"}\n` +
      `Required: ${job.analysis.requiredSkills.join(", ") || "n/a"}\nNice to have: ${job.analysis.niceToHaveSkills.join(", ") || "n/a"}\n` +
      `Summary: ${job.analysis.summary || "n/a"}`,
  });
}

// ---------------- Resume tailoring (quality model) ----------------

const TailorSchema = z.object({
  summary: z.string().catch(""),
  skills: strArr(60),
  experience: z
    .array(
      z.object({
        id: z.string(),
        bullets: z.array(z.object({ source: z.coerce.number().int().min(0), text: z.string() })).catch([]),
      }),
    )
    .catch([]),
});
export type AiTailorOutput = z.infer<typeof TailorSchema>;

export async function aiTailorResume(
  env: Env,
  userId: string,
  resume: BaseResume,
  job: { title: string; company: string; keywords: string[]; description: string },
  applicationId?: string,
): Promise<AiResult<AiTailorOutput>> {
  const experience = resume.experience.map((e) => ({
    id: e.id,
    role: `${e.title} at ${e.company} (${e.start || "?"} - ${e.end || "present"})`,
    bullets: e.bullets.map((b, i) => `[${i}] ${b}`),
  }));
  return runJson(env, {
    userId,
    task: "resume_tailor",
    applicationId,
    model: env.AI_MODEL_QUALITY,
    maxTokens: 2200,
    temperature: 0.2,
    schema: TailorSchema,
    jsonSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        skills: { type: "array", items: { type: "string" } },
        experience: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              bullets: {
                type: "array",
                items: { type: "object", properties: { source: { type: "integer" }, text: { type: "string" } }, required: ["source", "text"] },
              },
            },
            required: ["id", "bullets"],
          },
        },
      },
      required: ["summary", "skills", "experience"],
    },
    system:
      "You tailor a resume to a job description for ATS screening. ABSOLUTE RULES: " +
      "(1) Never invent experience, employers, titles, dates, metrics, numbers, degrees, certifications, tools or skills. " +
      "(2) Every rewritten bullet must restate the facts of exactly one source bullet (give its index as `source`); you may rephrase, " +
      "reorder emphasis and use the job's terminology ONLY where the source bullet already supports it. " +
      "(3) `skills` must be a reordered subset of the candidate's existing skills, most relevant first. " +
      "(4) `summary`: 2-3 sentences built only from facts and wording already present in the resume summary and bullets. " +
      "(5) For each role, return ALL bullets ordered by relevance to the job. " +
      "(6) Keep bullets concise — about the same length as the source. Never append commentary such as 'demonstrating…', 'showcasing…' or 'highlighting…', " +
      "and never add claims about qualities, leadership or impact that the source does not state. If a bullet needs no change, return it verbatim. " +
      'Respond with ONLY JSON: {"summary": string, "skills": string[], "experience": [{"id": string, "bullets": [{"source": number, "text": string}]}]}.',
    user:
      `JOB: ${job.title} at ${job.company}\nKEYWORDS: ${job.keywords.join(", ")}\nJOB DESCRIPTION (excerpt):\n${truncate(job.description, 3500)}\n\n` +
      `CANDIDATE RESUME\nHeadline: ${resume.headline}\nSummary: ${resume.summary}\nSkills: ${resume.skills.join(", ")}\n` +
      `Experience:\n${JSON.stringify(experience)}`,
  });
}

// ---------------- Complex application questions (quality model) ----------------

const AnswersSchema = z.object({
  answers: z
    .array(z.object({ key: z.string(), answer: z.string().catch(""), confident: z.boolean().catch(false) }))
    .catch([]),
});

export async function aiAnswerQuestions(
  env: Env,
  userId: string,
  questions: FormField[],
  context: { candidate: string; job: string },
  applicationId?: string,
): Promise<AiResult<z.infer<typeof AnswersSchema>>> {
  const qs = questions.map((q) => ({
    key: q.key,
    question: q.label,
    help: truncate(q.description, 300),
    options: q.options.length ? q.options.map((o) => o.label) : undefined,
  }));
  return runJson(env, {
    userId,
    task: "form_answers",
    applicationId,
    model: env.AI_MODEL_QUALITY,
    maxTokens: 1500,
    schema: AnswersSchema,
    system:
      "You draft answers to job application questions on behalf of the candidate, for the candidate to review. " +
      "Use ONLY facts from the candidate profile and resume. Never invent experience, numbers, dates, credentials or personal circumstances. " +
      "For motivation questions (e.g. 'Why this company?') write a sincere 80-150 word answer connecting real resume facts to the job. " +
      "If the question has options, answer with the exact text of one option. " +
      "If answering would require facts you do not have (personal details, legal attestations, preferences), return an empty answer with confident=false. " +
      'Respond with ONLY JSON: {"answers": [{"key": string, "answer": string, "confident": boolean}]}.',
    user: `CANDIDATE\n${context.candidate}\n\nJOB\n${context.job}\n\nQUESTIONS\n${JSON.stringify(qs)}`,
  });
}

// ---------------- Resume import (quality model, one-time) ----------------

const ImportSchema = z.object({
  headline: z.string().catch(""),
  summary: z.string().catch(""),
  skills: strArr(80),
  experience: z
    .array(
      z.object({
        company: z.string().catch(""),
        title: z.string().catch(""),
        location: z.string().catch(""),
        start: z.string().catch(""),
        end: z.string().catch(""),
        bullets: strArr(15),
      }),
    )
    .catch([]),
  education: z
    .array(
      z.object({
        school: z.string().catch(""),
        degree: z.string().catch(""),
        field: z.string().catch(""),
        start: z.string().catch(""),
        end: z.string().catch(""),
      }),
    )
    .catch([]),
  projects: z.array(z.object({ name: z.string().catch(""), url: z.string().catch(""), bullets: strArr(8) })).catch([]),
  certifications: strArr(20),
});
export type ImportedResume = z.infer<typeof ImportSchema>;

export async function aiStructureResume(env: Env, userId: string, markdown: string): Promise<AiResult<ImportedResume>> {
  return runJson(env, {
    userId,
    task: "resume_import",
    model: env.AI_MODEL_QUALITY,
    maxTokens: 3500,
    temperature: 0,
    schema: ImportSchema,
    system:
      "Convert the resume text into JSON. Copy content verbatim; do not summarize, embellish or add anything. " +
      "Dates as YYYY-MM when month is known, otherwise YYYY; empty string end date means present. " +
      'Respond with ONLY JSON: {"headline": string, "summary": string, "skills": string[], ' +
      '"experience": [{"company","title","location","start","end","bullets": string[]}], ' +
      '"education": [{"school","degree","field","start","end"}], "projects": [{"name","url","bullets": string[]}], "certifications": string[]}.',
    user: truncate(markdown, 14000),
  });
}
