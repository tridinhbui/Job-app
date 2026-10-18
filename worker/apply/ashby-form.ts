import type { FieldType, FormField } from "../../shared/types";
import { SourceError, USER_AGENT } from "../discovery/types";
import { htmlToText } from "../lib/util";

// Ashby publishes each posting's application form through the same public GraphQL endpoint
// its hosted job board uses, so answers are prepared without launching a browser.

const ENDPOINT = "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting";
const QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id
    applicationForm { sections { fieldEntries { ... on FormFieldEntry { id field isRequired descriptionHtml } } } }
  }
}`;

interface AshbyField {
  path: string;
  title: string;
  type: string;
  isDeactivated?: boolean;
  selectableValues?: { label: string; value: string }[];
}

const TYPE_MAP: Record<string, FieldType> = {
  String: "text",
  Email: "text",
  Phone: "text",
  Number: "text",
  LongText: "textarea",
  File: "file",
  Boolean: "select",
  ValueSelect: "select",
  MultiValueSelect: "multiselect",
  Location: "location",
  Date: "date",
};

export function parseAshbyUrl(url: string): { org: string; jobId: string } | null {
  const m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
  return m ? { org: decodeURIComponent(m[1]!), jobId: m[2]! } : null;
}

export async function fetchAshbyForm(org: string, jobId: string): Promise<FormField[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ operationName: "ApiJobPosting", variables: { organizationHostedJobsPageName: org, jobPostingId: jobId }, query: QUERY }),
  });
  if (!res.ok) throw new SourceError(`Ashby form request failed (${res.status})`, res.status >= 500);
  const data = (await res.json()) as {
    data?: { jobPosting?: { applicationForm?: { sections: { fieldEntries: { field: AshbyField; isRequired: boolean; descriptionHtml?: string | null }[] }[] } } | null };
  };
  const sections = data.data?.jobPosting?.applicationForm?.sections;
  if (!sections) throw new SourceError("Ashby posting not found or closed", false);

  const fields: FormField[] = [];
  for (const section of sections) {
    for (const entry of section.fieldEntries ?? []) {
      const f = entry.field;
      if (!f?.path || f.isDeactivated) continue;
      const type = TYPE_MAP[f.type];
      if (!type) continue; // unsupported widget (e.g. score / schedule) — left for the user
      fields.push({
        key: f.path,
        label: f.title.trim(),
        type,
        required: !!entry.isRequired,
        options: f.type === "Boolean" ? [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] : (f.selectableValues ?? []).map((v) => ({ label: v.label, value: String(v.value) })),
        description: htmlToText(entry.descriptionHtml ?? ""),
        section: "main",
      });
    }
  }
  return fields;
}
