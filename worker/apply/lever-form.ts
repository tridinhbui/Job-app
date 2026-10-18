import type { FieldType, FormField } from "../../shared/types";
import { SourceError, USER_AGENT } from "../discovery/types";
import { decodeEntities } from "../lib/util";

// Lever renders its application form as HTML. Custom questions are embedded as JSON in hidden
// "cards[<id>][baseTemplate]" inputs. Lever forms use hCaptcha, so ApplyPilot only prepares
// answers here and the user submits through "assisted apply" — it never clicks submit.

const STANDARD: { name: string; label: string; type: FieldType; required: boolean }[] = [
  { name: "resume", label: "Resume/CV", type: "file", required: true },
  { name: "name", label: "Full name", type: "text", required: true },
  { name: "email", label: "Email", type: "text", required: true },
  { name: "phone", label: "Phone", type: "text", required: false },
  { name: "location", label: "Current location", type: "text", required: false },
  { name: "org", label: "Current company", type: "text", required: false },
  { name: "comments", label: "Additional information", type: "textarea", required: false },
];

const CARD_TYPES: Record<string, FieldType> = {
  text: "text",
  textarea: "textarea",
  "multiple-choice": "select",
  dropdown: "select",
  "multiple-select": "multiselect",
};

export function parseLeverUrl(url: string): { company: string; postingId: string } | null {
  const m = url.match(/jobs(?:\.eu)?\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i);
  return m ? { company: m[1]!, postingId: m[2]! } : null;
}

export function parseLeverHtml(html: string): FormField[] {
  const fields: FormField[] = [];
  for (const s of STANDARD) {
    if (new RegExp(`name="${s.name}"`).test(html)) fields.push({ key: s.name, label: s.label, type: s.type, required: s.required, options: [], description: "", section: "main" });
  }
  for (const m of html.matchAll(/name="urls\[([^\]]+)\]"/g)) {
    const site = decodeEntities(m[1]!);
    fields.push({ key: `urls[${site}]`, label: `${site} URL`, type: "text", required: false, options: [], description: "", section: "main" });
  }
  // Custom question cards.
  for (const tag of html.match(/<input[^>]+name="cards\[[\w-]+\]\[baseTemplate\]"[^>]*>/g) ?? []) {
    const id = tag.match(/cards\[([\w-]+)\]/)?.[1];
    const value = tag.match(/value="([^"]*)"/)?.[1];
    if (!id || !value) continue;
    let card: { fields?: { type: string; text: string; description?: string; required?: boolean; options?: { text: string }[] }[] };
    try {
      card = JSON.parse(decodeEntities(value));
    } catch {
      continue;
    }
    (card.fields ?? []).forEach((f, i) => {
      const type = CARD_TYPES[f.type];
      if (!type) return;
      fields.push({
        key: `cards[${id}][field${i}]`,
        label: f.text.trim(),
        type,
        required: !!f.required,
        options: (f.options ?? []).map((o) => ({ label: o.text, value: o.text })),
        description: f.description ?? "",
        section: "main",
      });
    });
  }
  return fields;
}

export async function fetchLeverForm(company: string, postingId: string): Promise<FormField[]> {
  const res = await fetch(`https://jobs.lever.co/${encodeURIComponent(company)}/${postingId}/apply`, { headers: { "user-agent": USER_AGENT, accept: "text/html" } });
  if (res.status === 404) throw new SourceError("Lever posting not found or closed", false);
  if (!res.ok) throw new SourceError(`Lever form request failed (${res.status})`, res.status >= 500);
  return parseLeverHtml(await res.text());
}
