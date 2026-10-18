import { AlertTriangle, Download, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { SENIORITY_ORDER, type PersonalInfo, type Preferences, type UsageSummary, type UserSettings } from "../../shared/types";
import { useMe } from "../App";
import { api, fmtMoney, timeAgo, useApi } from "../api";
import { Badge, Button, Card, CardHeader, cx, ErrorNote, Field, inputCls, PageHeader, Progress, Spinner, TagInput, Toggle, useToast } from "../ui";

interface ProfileResponse {
  personal: PersonalInfo;
  preferences: Preferences;
  settings: UserSettings;
  answers: { question: string; answer: string; updatedAt: number }[];
}

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "preferences", label: "Job preferences" },
  { id: "sources", label: "Job boards" },
  { id: "usage", label: "Automation & AI" },
  { id: "answers", label: "Answer library" },
  { id: "data", label: "Data & privacy" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function useSaver() {
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const save = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setSaving(key);
    try {
      await fn();
      toast(msg);
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    } finally {
      setSaving(null);
    }
  };
  return { saving, save };
}

// ---------------- profile ----------------

function EeoSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const mode = value === "" ? "" : value === "decline" ? "decline" : "custom";
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <select className={cx(inputCls, mode === "custom" ? "w-40" : "")} value={mode} onChange={(e) => onChange(e.target.value === "custom" ? " " : e.target.value)}>
          <option value="">Leave unanswered</option>
          <option value="decline">Decline to self-identify</option>
          <option value="custom">Specific answer…</option>
        </select>
        {mode === "custom" && <input className={inputCls} value={value.trim()} placeholder="Exact option text" onChange={(e) => onChange(e.target.value || " ")} />}
      </div>
    </Field>
  );
}

function ProfileTab({ initial, onSaved }: { initial: PersonalInfo; onSaved: () => void }) {
  const [p, setP] = useState(initial);
  const { saving, save } = useSaver();
  const set = <K extends keyof PersonalInfo>(k: K, v: PersonalInfo[K]) => setP((x) => ({ ...x, [k]: v }));
  const text = (k: keyof PersonalInfo, label: string, placeholder?: string) => (
    <Field label={label}>
      <input className={inputCls} value={p[k] as string} placeholder={placeholder} onChange={(e) => set(k, e.target.value as never)} />
    </Field>
  );
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Contact details" subtitle="Encrypted at rest and only used to fill your applications." />
        <div className="grid gap-3 sm:grid-cols-2">
          {text("firstName", "First name")}
          {text("lastName", "Last name")}
          {text("email", "Email")}
          {text("phone", "Phone", "+1 415 555 0100")}
          {text("phoneCountry", "Phone country", "United States")}
          {text("city", "City")}
          {text("region", "State / region")}
          {text("country", "Country")}
          {text("linkedin", "LinkedIn URL")}
          {text("github", "GitHub URL")}
          {text("website", "Website / portfolio")}
          {text("pronouns", "Pronouns (optional)")}
        </div>
      </Card>
      <Card>
        <CardHeader title="Work eligibility & logistics" subtitle="Used for hard filters (sponsorship) and to answer common form questions." />
        <div className="space-y-4">
          <Field label="Countries where you can work without sponsorship">
            <TagInput value={p.workAuthorizedCountries} onChange={(v) => set("workAuthorizedCountries", v)} placeholder="United States" />
          </Field>
          <Toggle checked={p.requiresSponsorship} onChange={(v) => set("requiresSponsorship", v)} label="I require visa sponsorship" description="Jobs that state they don't sponsor are filtered out." />
          <Toggle checked={p.willingToRelocate} onChange={(v) => set("willingToRelocate", v)} label="Open to relocation" />
          <div className="grid gap-3 sm:grid-cols-2">
            {text("earliestStart", "Earliest start date", "Two weeks after offer")}
            {text("noticePeriod", "Notice period", "2 weeks")}
            {text("salaryExpectation", "Salary expectation (for forms)", "$180,000 base")}
            {text("howDidYouHear", "“How did you hear about us?” default", "Company website")}
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Voluntary self-identification" subtitle="Optional. Left unanswered unless you choose otherwise." />
        <div className="grid gap-3 sm:grid-cols-2">
          <EeoSelect label="Gender" value={p.eeo.gender} onChange={(v) => set("eeo", { ...p.eeo, gender: v })} />
          <EeoSelect label="Race" value={p.eeo.race} onChange={(v) => set("eeo", { ...p.eeo, race: v })} />
          <EeoSelect label="Hispanic / Latino" value={p.eeo.hispanic} onChange={(v) => set("eeo", { ...p.eeo, hispanic: v })} />
          <EeoSelect label="Veteran status" value={p.eeo.veteran} onChange={(v) => set("eeo", { ...p.eeo, veteran: v })} />
          <EeoSelect label="Disability status" value={p.eeo.disability} onChange={(v) => set("eeo", { ...p.eeo, disability: v })} />
        </div>
      </Card>
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={saving === "p"}
          onClick={() =>
            save("p", () => api("/profile/personal", { method: "PUT", json: { ...p, eeo: Object.fromEntries(Object.entries(p.eeo).map(([k, v]) => [k, v.trim()])) } }), "Profile saved").then(onSaved)
          }
        >
          Save profile
        </Button>
      </div>
    </div>
  );
}

// ---------------- preferences ----------------

function PreferencesTab({ initial, onSaved }: { initial: Preferences; onSaved: () => void }) {
  const [p, setP] = useState(initial);
  const { saving, save } = useSaver();
  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setP((x) => ({ ...x, [k]: v }));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="What you're looking for" subtitle="Hard filters run before any scoring or AI, so excluded jobs cost nothing." />
        <div className="space-y-4">
          <Field label="Target titles">
            <TagInput value={p.targetTitles} onChange={(v) => set("targetTitles", v)} placeholder="Backend Engineer, Platform Engineer" />
          </Field>
          <Field label="Seniority">
            <div className="flex flex-wrap gap-1.5">
              {SENIORITY_ORDER.map((s) => {
                const on = p.seniority.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => set("seniority", on ? p.seniority.filter((x) => x !== s) : [...p.seniority, s])}
                    className={cx("rounded-md border px-2.5 py-1 text-xs capitalize", on ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50")}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Workplace">
              <select className={inputCls} value={p.workplace} onChange={(e) => set("workplace", e.target.value as Preferences["workplace"])}>
                <option value="any">Any</option>
                <option value="remote_or_hybrid">Remote or hybrid</option>
                <option value="remote_only">Remote only</option>
              </select>
            </Field>
            <Field label="Preferred locations" hint="Cities, states or countries. Remote jobs always pass.">
              <TagInput value={p.locations} onChange={(v) => set("locations", v)} placeholder="San Francisco, United States" />
            </Field>
            <Field label="Minimum annual salary" hint="Jobs whose stated range tops out below this are filtered out.">
              <div className="flex gap-2">
                <input type="number" className={inputCls} value={p.minSalary ?? ""} onChange={(e) => set("minSalary", e.target.value ? Number(e.target.value) : null)} placeholder="150000" />
                <select className={cx(inputCls, "w-24")} value={p.salaryCurrency} onChange={(e) => set("salaryCurrency", e.target.value)}>
                  {["USD", "EUR", "GBP", "CAD", "AUD"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            </Field>
            <Field label={`Minimum match score to keep: ${p.minScore}`}>
              <input type="range" min={0} max={90} step={5} value={p.minScore} onChange={(e) => set("minScore", Number(e.target.value))} className="w-full accent-zinc-900" />
            </Field>
          </div>
          <Field label="Exclude titles containing">
            <TagInput value={p.excludeTitleKeywords} onChange={(v) => set("excludeTitleKeywords", v)} placeholder="intern, sales, contract" />
          </Field>
          <Field label="Excluded companies">
            <TagInput value={p.excludedCompanies} onChange={(v) => set("excludedCompanies", v)} />
          </Field>
          <Field label="Interests" hint="Domains you care about get a small score boost.">
            <TagInput value={p.interests} onChange={(v) => set("interests", v)} placeholder="developer tools, climate, healthcare" />
          </Field>
        </div>
      </Card>
      <div className="flex justify-end">
        <Button variant="primary" loading={saving === "p"} onClick={() => save("p", () => api("/profile/preferences", { method: "PUT", json: p }), "Preferences saved — re-matching jobs").then(onSaved)}>
          Save preferences
        </Button>
      </div>
    </div>
  );
}

// ---------------- sources ----------------

interface Source {
  id: string;
  ats: string;
  token: string;
  company_name: string;
  last_crawled_at: number | null;
  last_status: string | null;
  last_error: string | null;
  job_count: number;
}

const ATS_HELP: Record<string, string> = {
  greenhouse: "Board token or URL, e.g. job-boards.greenhouse.io/stripe → stripe",
  lever: "Company slug or URL, e.g. jobs.lever.co/palantir → palantir",
  ashby: "Board name or URL, e.g. jobs.ashbyhq.com/openai → openai",
  jsonld: "Careers page URL publishing schema.org JobPosting data (robots.txt is respected)",
};

function SourcesTab() {
  const { data, error, reload } = useApi<{ sources: Source[] }>("/sources", { pollMs: 20_000 });
  const [ats, setAts] = useState("greenhouse");
  const [token, setToken] = useState("");
  const [company, setCompany] = useState("");
  const { saving, save } = useSaver();

  const add = async () => {
    const ok = await save("add", () => api("/sources", { method: "POST", json: { ats, token, companyName: company } }), "Board added — first crawl is running");
    if (ok) {
      setToken("");
      setCompany("");
      void reload(true);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Follow a job board" subtitle="Public ATS APIs only. Each board is crawled at most every 6 hours and shared across users." />
        <div className="grid gap-3 sm:grid-cols-[160px_1fr_200px_auto] sm:items-end">
          <Field label="Platform">
            <select className={inputCls} value={ats} onChange={(e) => setAts(e.target.value)}>
              <option value="greenhouse">Greenhouse</option>
              <option value="lever">Lever</option>
              <option value="ashby">Ashby</option>
              <option value="jsonld">Career page (JSON-LD)</option>
            </select>
          </Field>
          <Field label="Board">
            <input className={inputCls} value={token} onChange={(e) => setToken(e.target.value)} placeholder={ats === "jsonld" ? "https://company.com/careers" : "board token or URL"} />
          </Field>
          <Field label="Company name (optional)">
            <input className={inputCls} value={company} onChange={(e) => setCompany(e.target.value)} />
          </Field>
          <Button variant="primary" onClick={add} loading={saving === "add"} disabled={!token.trim()}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">{ATS_HELP[ats]}</p>
      </Card>
      {error && <ErrorNote message={error} />}
      <Card padded={false}>
        {!data ? (
          <Spinner />
        ) : data.sources.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500">You're not following any boards yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {data.sources.map((s) => (
              <li key={s.id} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{s.company_name}</span>
                    <Badge>{s.ats}</Badge>
                    <Badge tone={s.last_status === "ok" ? "green" : s.last_status ? "red" : "zinc"}>{s.last_status ?? "queued"}</Badge>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500">
                    {s.job_count} open jobs · crawled {timeAgo(s.last_crawled_at)}
                    {s.last_error ? ` · ${s.last_error}` : ""}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => save(s.id, () => api(`/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }), "Unfollowed").then(() => reload(true))}>
                  <Trash2 className="h-3 w-3" /> Unfollow
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------- automation & usage ----------------

interface UsageResponse {
  summary: UsageSummary;
  projectedUsd: number;
  byTask: { task: string; calls: number; input_tokens: number; output_tokens: number; cost: number }[];
  recent: { task: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number; estimated: number; created_at: number }[];
  months: { month: string; spent_usd: number; calls: number; cache_hits: number; blocked: number }[];
}

const TASK_LABEL: Record<string, string> = {
  jd_analysis: "Job description analysis",
  match_reasoning: "Ambiguous match review",
  resume_tailor: "Resume tailoring",
  form_answers: "Complex form questions",
  resume_import: "Resume import",
};

function AutomationTab({ initial, onSaved }: { initial: UserSettings; onSaved: () => void }) {
  const [s, setS] = useState(initial);
  const { saving, save } = useSaver();
  const { me, reloadMe } = useMe();
  const { data: usage } = useApi<UsageResponse>("/usage");
  const set = <K extends keyof UserSettings>(k: K, v: UserSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const u = usage?.summary;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="AI budget" subtitle="Deterministic TypeScript handles filtering, scoring, crawling and browser steps. AI is used only where it adds value." />
        <div className="space-y-4">
          <Toggle checked={s.aiEnabled} onChange={(v) => set("aiEnabled", v)} label="Use Workers AI" description="When off (or when the budget runs out) everything still works with deterministic fallbacks." />
          <Field label={`Monthly budget: ${fmtMoney(s.monthlyBudgetUsd, 0)}`} hint="Match reasoning pauses at 60%, job analysis at 85%; resume tailoring and form answers continue until 100%.">
            <input type="range" min={0} max={30} step={1} value={s.monthlyBudgetUsd} onChange={(e) => set("monthlyBudgetUsd", Number(e.target.value))} className="w-full accent-zinc-900" />
          </Field>
          {u && (
            <div className="rounded-lg bg-zinc-50 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-xl font-semibold tabular-nums">{fmtMoney(u.spentUsd, 3)}</span>
                  <span className="ml-1 text-sm text-zinc-500">spent in {u.month}</span>
                </div>
                <span className="text-xs text-zinc-500">
                  Projected {fmtMoney(usage.projectedUsd, 2)} · {u.calls} calls · {u.cacheHits} cache hits · {u.blocked} skipped
                </span>
              </div>
              <div className="mt-2">
                <Progress value={u.budgetUsd ? (u.spentUsd / u.budgetUsd) * 100 : 0} tone={u.mode === "exhausted" ? "red" : u.mode === "normal" ? "zinc" : "amber"} />
              </div>
            </div>
          )}
          {usage && usage.byTask.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1.5 font-medium">Task</th>
                  <th className="py-1.5 text-right font-medium">Calls</th>
                  <th className="py-1.5 text-right font-medium">Tokens in / out</th>
                  <th className="py-1.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {usage.byTask.map((t) => (
                  <tr key={t.task}>
                    <td className="py-2">{TASK_LABEL[t.task] ?? t.task}</td>
                    <td className="py-2 text-right tabular-nums">{t.calls}</td>
                    <td className="py-2 text-right tabular-nums text-zinc-500">
                      {t.input_tokens.toLocaleString()} / {t.output_tokens.toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums">{fmtMoney(t.cost, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {usage && usage.recent.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs font-medium text-zinc-500">Recent calls</summary>
              <ul className="mt-2 space-y-1 text-xs text-zinc-600">
                {usage.recent.map((r, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate">
                      {TASK_LABEL[r.task] ?? r.task} · <span className="text-zinc-400">{r.model.replace("@cf/", "")}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {fmtMoney(r.cost_usd, 5)}
                      {r.estimated ? "*" : ""} · {timeAgo(r.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Automation" subtitle="ApplyPilot can find and prepare applications on its own. Submission always requires your explicit approval." />
        <div className="space-y-4">
          <Field label={s.autoShortlistScore ? `Auto-shortlist matches scoring ${s.autoShortlistScore}+` : "Auto-shortlist: off"}>
            <input type="range" min={0} max={95} step={5} value={s.autoShortlistScore} onChange={(e) => set("autoShortlistScore", Number(e.target.value))} className="w-full accent-zinc-900" />
          </Field>
          <Toggle checked={s.autoPrepare} onChange={(v) => set("autoPrepare", v)} label="Auto-prepare shortlisted jobs" description="Tailors the resume and drafts answers in the background (uses AI budget)." />
          {s.autoPrepare && (
            <Field label="Daily auto-prepare limit">
              <input type="number" min={0} max={50} className={cx(inputCls, "w-28")} value={s.autoPrepareDailyLimit} onChange={(e) => set("autoPrepareDailyLimit", Number(e.target.value))} />
            </Field>
          )}
          <div className="rounded-lg border border-zinc-200 p-4">
            <Toggle
              checked={s.liveSubmitEnabled}
              onChange={(v) => set("liveSubmitEnabled", v)}
              label="Allow live submission after my approval"
              description="When off, approvals run as dry runs: the form is filled in a browser and screenshotted, but never submitted."
            />
            {me?.submitMode !== "live" && (
              <p className="mt-3 flex gap-2 text-xs text-zinc-500">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                This deployment runs with SUBMIT_MODE=dry_run, so live submission stays disabled regardless of this setting.
              </p>
            )}
          </div>
        </div>
      </Card>
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={saving === "s"}
          onClick={() =>
            save("s", () => api("/settings", { method: "PUT", json: s }), "Settings saved").then(() => {
              reloadMe();
              onSaved();
            })
          }
        >
          Save settings
        </Button>
      </div>
    </div>
  );
}

// ---------------- answer library ----------------

function AnswersTab({ initial, onSaved }: { initial: ProfileResponse["answers"]; onSaved: () => void }) {
  const [list, setList] = useState(initial.map(({ question, answer }) => ({ question, answer })));
  const { saving, save } = useSaver();
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Saved answers"
          subtitle="Reused automatically when a form asks a matching question. Answers you edit during review can be saved here."
          action={
            <Button size="sm" onClick={() => setList([...list, { question: "", answer: "" }])}>
              <Plus className="h-3 w-3" /> Add
            </Button>
          }
        />
        {list.length === 0 && <p className="text-sm text-zinc-500">No saved answers yet.</p>}
        <div className="space-y-3">
          {list.map((a, i) => (
            <div key={i} className="rounded-lg border border-zinc-200 p-3">
              <input className={cx(inputCls, "mb-2 font-medium")} placeholder="Question" value={a.question} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} />
              <textarea className={cx(inputCls, "min-h-[70px]")} placeholder="Answer" value={a.answer} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))} />
              <div className="mt-1 flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => setList(list.filter((_, j) => j !== i))}>
                  <Trash2 className="h-3 w-3" /> Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <div className="flex justify-end">
        <Button variant="primary" loading={saving === "a"} onClick={() => save("a", () => api("/answers", { method: "PUT", json: { answers: list } }), "Answer library saved").then(onSaved)}>
          Save answers
        </Button>
      </div>
    </div>
  );
}

// ---------------- data ----------------

function DataTab() {
  const [confirm, setConfirm] = useState("");
  const { saving, save } = useSaver();
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="How your data is stored" />
        <ul className="space-y-1.5 text-sm text-zinc-600">
          <li>· Personal details, resume, saved answers and prepared form answers are AES-256-GCM encrypted in D1.</li>
          <li>· Resume files, tailored PDFs and screenshots are encrypted before being written to a private R2 bucket.</li>
          <li>· Access requires Cloudflare Access; the API verifies the Access token on every request.</li>
          <li>· AI calls run on Cloudflare Workers AI; no third-party AI or database services are used.</li>
        </ul>
        <a href="/api/export" className="mt-4 inline-block">
          <Button>
            <Download className="h-3.5 w-3.5" /> Export my data (JSON)
          </Button>
        </a>
      </Card>
      <Card className="border-red-200">
        <CardHeader title="Delete account" subtitle="Permanently deletes your profile, resumes, applications and files. This cannot be undone." />
        <div className="flex flex-wrap gap-2">
          <input className={cx(inputCls, "max-w-xs")} placeholder='Type "DELETE" to confirm' value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button
            variant="danger"
            disabled={confirm !== "DELETE"}
            loading={saving === "del"}
            onClick={() => save("del", () => api("/account", { method: "DELETE", json: { confirm } }), "Account deleted").then((ok) => ok && window.location.assign("/"))}
          >
            Delete everything
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function Settings() {
  const { data, error, loading, reload } = useApi<ProfileResponse>("/profile");
  const onSaved = () => void reload(true);
  const location = useLocation();
  const navigate = useNavigate();
  const fromHash = location.hash.slice(1) as Tab;
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.id === fromHash) ? fromHash : "profile");
  useEffect(() => {
    if (TABS.some((t) => t.id === fromHash)) setTab(fromHash);
  }, [fromHash]);

  return (
    <div>
      <PageHeader title="Settings" description="Profile, preferences, job boards, automation and privacy." />
      <div className="scroll-thin mb-6 flex gap-1 overflow-x-auto border-b border-zinc-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => navigate({ hash: t.id }, { replace: true })}
            className={cx("-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition", tab === t.id ? "border-zinc-900 font-medium text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800")}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && <ErrorNote message={error} />}
      {loading || !data ? (
        <Spinner />
      ) : (
        <>
          {tab === "profile" && <ProfileTab initial={data.personal} onSaved={onSaved} />}
          {tab === "preferences" && <PreferencesTab initial={data.preferences} onSaved={onSaved} />}
          {tab === "sources" && <SourcesTab />}
          {tab === "usage" && <AutomationTab initial={data.settings} onSaved={onSaved} />}
          {tab === "answers" && <AnswersTab initial={data.answers} onSaved={onSaved} />}
          {tab === "data" && <DataTab />}
        </>
      )}
    </div>
  );
}
