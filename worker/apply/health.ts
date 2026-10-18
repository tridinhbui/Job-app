import { emptyPersonal, emptyResume } from "../../shared/defaults";
import type { Env } from "../env";
import { errorMessage, now, truncate } from "../lib/util";
import { renderResumePdf } from "../resume/pdf";
import { ADAPTERS } from "./adapters";
import { prepareDeterministicAnswers } from "./answers";

// Weekly canary: dry-run each automated adapter on a real open posting with a throwaway probe
// profile. Dry-run blocks every write, so nothing is ever sent. A low fill ratio means the
// site's form changed and the adapter needs attention (surfaced on the Today page).

const PROBE = { ...emptyPersonal(), firstName: "Probe", lastName: "Check", email: "probe@example.invalid", phone: "+1 555 010 0000", city: "San Francisco", region: "CA", country: "United States", linkedin: "https://www.linkedin.com/in/example" };

export async function probeAdapters(env: Env): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const resume = await renderResumePdf(emptyResume(), PROBE);
  for (const adapter of ADAPTERS.filter((a) => a.mode === "automated" && a.run && a.loadForm)) {
    try {
      const job = await env.DB.prepare(`SELECT j.apply_url FROM jobs j JOIN sources s ON s.id = j.source_id WHERE s.ats = ? AND j.status = 'open' ORDER BY j.first_seen_at DESC LIMIT 1`)
        .bind(adapter.id)
        .first<{ apply_url: string }>();
      if (!job) continue;
      const fields = await adapter.loadForm!(job.apply_url);
      const { answers } = prepareDeterministicAnswers(fields, { personal: PROBE, resume: emptyResume(), library: [], job: { company: "", title: "", location: null } });
      const attempted = answers.filter((a) => (Array.isArray(a.value) ? a.value.length : a.value.trim()));
      const res = await adapter.run!(env, { applyUrl: job.apply_url, answers: attempted, resume: { name: "probe.pdf", bytes: resume }, phoneCountry: "United States", mode: "dry_run", beforeClick: async () => false });
      const ratio = attempted.length ? res.filled.length / attempted.length : 0;
      const ok = res.outcome === "dry_run_ok" && ratio >= 0.9;
      const message = ok ? null : `${adapter.id} form automation may be out of date (${Math.round(ratio * 100)}% of fields filled: ${truncate(res.message, 200)})`;
      await env.DB.prepare("INSERT OR REPLACE INTO adapter_health (ats, checked_at, fill_ratio, ok, message) VALUES (?, ?, ?, ?, ?)").bind(adapter.id, now(), ratio, ok ? 1 : 0, message).run();
      out[adapter.id] = ok ? "ok" : (message ?? "failed");
    } catch (e) {
      out[adapter.id] = `error: ${errorMessage(e)}`;
    }
  }
  return out;
}
