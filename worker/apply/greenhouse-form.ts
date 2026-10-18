import type { FieldType, FormField } from "../../shared/types";
import { fetchJson } from "../discovery/types";
import { htmlToText } from "../lib/util";

// Greenhouse publishes each job's application form via its public Job Board API, so the
// form is read without launching a browser (zero browser time during preparation).

interface GhQuestion {
  label: string;
  description: string | null;
  required: boolean;
  fields: { name: string; type: string; values: { label: string; value: string | number }[] }[];
}

interface GhJobDetail {
  questions?: GhQuestion[];
  location_questions?: GhQuestion[];
  compliance?: { type: string; questions: GhQuestion[] }[] | null;
  demographic_questions?: { questions?: { id: number; label: string; required: boolean; type: string; answer_options?: { id: number; label: string }[] }[] } | null;
}

const TYPE_MAP: Record<string, FieldType> = {
  input_text: "text",
  input_hidden: "text",
  textarea: "textarea",
  input_file: "file",
  multi_value_single_select: "select",
  multi_value_multi_select: "multiselect",
};

export function parseGreenhouseUrl(applyUrl: string): { board: string; jobId: string } | null {
  const u = new URL(applyUrl);
  const board = u.searchParams.get("for");
  const jobId = u.searchParams.get("token");
  if (board && jobId) return { board, jobId };
  const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  return m ? { board: m[1]!, jobId: m[2]! } : null;
}

function toFields(q: GhQuestion, section: FormField["section"]): FormField[] {
  const out: FormField[] = [];
  // Resume questions offer file OR text; we always use the file input.
  const fields = q.fields.some((f) => f.type === "input_file") ? q.fields.filter((f) => f.type === "input_file") : q.fields;
  for (const f of fields) {
    if (f.type === "input_hidden") continue;
    const isLocation = /location/i.test(f.name) || (f.name === "location" && /location/i.test(q.label));
    out.push({
      key: f.name,
      label: q.label.trim(),
      type: isLocation ? "location" : (TYPE_MAP[f.type] ?? "text"),
      required: q.required,
      options: (f.values ?? []).map((v) => ({ label: String(v.label), value: String(v.value) })),
      description: htmlToText(q.description ?? ""),
      section,
    });
  }
  return out;
}

export async function fetchGreenhouseForm(board: string, jobId: string): Promise<FormField[]> {
  const d = await fetchJson<GhJobDetail>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}?questions=true`,
  );
  const fields: FormField[] = [];
  for (const q of d.questions ?? []) fields.push(...toFields(q, "main"));
  for (const q of d.location_questions ?? []) fields.push(...toFields(q, "main"));
  for (const c of d.compliance ?? []) for (const q of c.questions ?? []) fields.push(...toFields(q, "compliance"));
  for (const q of d.demographic_questions?.questions ?? []) {
    fields.push({
      key: `demographic_${q.id}`,
      label: q.label,
      type: q.type === "multi_value_multi_select" ? "multiselect" : "select",
      required: q.required,
      options: (q.answer_options ?? []).map((o) => ({ label: o.label, value: String(o.id) })),
      description: "",
      section: "compliance",
    });
  }
  // De-duplicate by key (some boards repeat fields across sections).
  const seen = new Set<string>();
  return fields.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}
