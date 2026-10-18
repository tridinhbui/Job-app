import { AlertTriangle, Download, ExternalLink, FlaskConical, Image, Send, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppStatus, FormField, PreparedAnswer, TailoredResume } from "../../shared/types";
import { useMe } from "../App";
import { api, timeAgo, useApi } from "../api";
import { Badge, Button, cx, Drawer, ErrorNote, inputCls, Spinner, StatusBadge, statusLabel, useToast } from "../ui";

export interface ApplicationDetail {
  id: string;
  status: AppStatus;
  adapter: string | null;
  tailorMethod: string | null;
  submitMode: string | null;
  submittedAt: number | null;
  confirmationText: string | null;
  error: string | null;
  notes: string | null;
  hasScreenshot: boolean;
  hasResume: boolean;
  answers: PreparedAnswer[];
  missing: string[];
  form: FormField[];
  tailored: TailoredResume | null;
  job: { id: string; title: string; company: string; location: string | null; job_url: string; apply_url: string; status: string } | null;
  events: { id: number; type: string; from_status: AppStatus | null; to_status: AppStatus | null; message: string | null; created_at: number }[];
  globalSubmitMode: "dry_run" | "live";
}

const SOURCE_LABEL: Record<PreparedAnswer["source"], { label: string; tone: "zinc" | "green" | "violet" | "blue" | "amber" }> = {
  profile: { label: "Profile", tone: "zinc" },
  library: { label: "Saved answer", tone: "blue" },
  ai: { label: "AI draft", tone: "violet" },
  default: { label: "Default", tone: "zinc" },
  user: { label: "You", tone: "green" },
  file: { label: "File", tone: "zinc" },
  none: { label: "Empty", tone: "amber" },
};

const BUSY: AppStatus[] = ["preparing", "approved", "submitting"];
const TRACK_ACTIONS: { to: AppStatus; label: string; from: AppStatus[] }[] = [
  { to: "submitted", label: "Mark submitted", from: ["shortlisted", "prepared", "needs_manual", "failed"] },
  { to: "interview", label: "Interview", from: ["submitted", "rejected"] },
  { to: "offered", label: "Offer", from: ["submitted", "interview"] },
  { to: "rejected", label: "Rejected", from: ["submitted", "interview", "offered"] },
  { to: "withdrawn", label: "Withdraw", from: ["shortlisted", "prepared", "needs_manual", "failed", "submitted", "interview", "offered"] },
];

function AnswerInput({ answer, field, value, onChange, disabled }: { answer: PreparedAnswer; field?: FormField; value: string | string[]; onChange: (v: string | string[]) => void; disabled: boolean }) {
  if (answer.type === "file") return <div className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">{answer.key === "resume" ? "Tailored resume PDF is uploaded automatically" : "Upload manually on the site"}</div>;
  const options = field?.options ?? [];
  if ((answer.type === "select" || answer.type === "multiselect") && options.length) {
    if (answer.type === "multiselect") {
      const arr = Array.isArray(value) ? value : value ? [value] : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => {
            const on = arr.includes(o.label);
            return (
              <button
                type="button"
                disabled={disabled}
                key={o.value}
                onClick={() => onChange(on ? arr.filter((x) => x !== o.label) : [...arr, o.label])}
                className={cx("rounded-md border px-2 py-1 text-xs", on ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50")}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <select className={inputCls} value={Array.isArray(value) ? (value[0] ?? "") : value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">— Select —</option>
        {options.map((o) => (
          <option key={o.value} value={o.label}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  const v = Array.isArray(value) ? value.join(", ") : value;
  return answer.type === "textarea" ? (
    <textarea className={cx(inputCls, "min-h-[110px]")} value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
  ) : (
    <input className={inputCls} value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
  );
}

export function ApplicationDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [poll, setPoll] = useState(0);
  const { data: app, error, reload } = useApi<ApplicationDetail>(id ? `/applications/${id}` : null, { pollMs: poll });
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [dirty, setDirty] = useState(false);
  const [saveToLibrary, setSaveToLibrary] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const toast = useToast();
  const { me } = useMe();

  useEffect(() => {
    if (!app) return;
    setPoll(BUSY.includes(app.status) ? 4000 : 0);
    if (!dirty) setValues(Object.fromEntries(app.answers.map((a) => [a.key, a.value])));
    setNote(app.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app]);
  useEffect(() => {
    setDirty(false);
    setReviewed(false);
  }, [id]);

  const run = async (label: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try {
      await fn();
      toast(success);
      onChanged();
      await reload(true);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const saveAnswers = () =>
    run(
      "save",
      async () => {
        await api(`/applications/${id}/answers`, { method: "PUT", json: { answers: Object.entries(values).map(([key, value]) => ({ key, value })), saveToLibrary } });
        setDirty(false);
      },
      "Answers saved",
    );

  const approve = (mode: "dry_run" | "live") =>
    run(mode, () => api(`/applications/${id}/approve`, { method: "POST", json: { mode, confirm: true } }), mode === "live" ? "Approved — submitting now" : "Dry run started — the form will be filled but not submitted");

  const setStatus = (status: AppStatus) => run(status, () => api(`/applications/${id}/status`, { method: "POST", json: { status, note: "" } }), `Marked ${statusLabel(status)}`);

  const editable = !!app && ["prepared", "needs_manual", "failed"].includes(app.status) && app.answers.length > 0;
  const needsReview = app?.answers.some((a) => a.needsReview) ?? false;
  const liveAvailable = app?.globalSubmitMode === "live" && me?.submitMode === "live";
  const fieldByKey = new Map((app?.form ?? []).map((f) => [f.key, f]));

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      title={app?.job ? app.job.title : "Application"}
      subtitle={app?.job && [app.job.company, app.job.location].filter(Boolean).join(" · ")}
      footer={
        app && (
          <div className="space-y-3">
            {app.status === "prepared" && app.adapter === "greenhouse" && (
              <>
                <label className="flex items-start gap-2 text-sm text-zinc-700">
                  <input type="checkbox" className="mt-0.5 rounded border-zinc-300" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                  I reviewed the tailored resume and every answer, and they are accurate.
                </label>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {(dirty || needsReview) && <span className="mr-auto text-xs text-amber-700">Save your answers before approving.</span>}
                  <Button onClick={() => approve("dry_run")} disabled={!reviewed || dirty || needsReview || app.missing.length > 0} loading={busy === "dry_run"}>
                    <FlaskConical className="h-3.5 w-3.5" /> Dry run
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => approve("live")}
                    disabled={!reviewed || dirty || needsReview || app.missing.length > 0 || !liveAvailable}
                    loading={busy === "live"}
                    title={liveAvailable ? "Fill the form and click submit" : "Live submission is disabled (SUBMIT_MODE or Settings)"}
                  >
                    <Send className="h-3.5 w-3.5" /> Approve & submit
                  </Button>
                </div>
              </>
            )}
            {app.status === "prepared" && app.adapter !== "greenhouse" && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-zinc-600">No automation adapter for this board — apply with your tailored resume.</span>
                <div className="flex gap-2">
                  <a href={app.job?.apply_url} target="_blank" rel="noreferrer">
                    <Button>
                      Open application <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </a>
                  <Button variant="primary" onClick={() => setStatus("submitted")} loading={busy === "submitted"}>
                    I submitted it
                  </Button>
                </div>
              </div>
            )}
            {app.status === "needs_manual" && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <a href={app.job?.apply_url} target="_blank" rel="noreferrer">
                  <Button>
                    Finish on the site <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </a>
                <Button variant="primary" onClick={() => setStatus("submitted")} loading={busy === "submitted"}>
                  I submitted it
                </Button>
              </div>
            )}
            {(app.status === "shortlisted" || app.status === "failed") && (
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => run("prep", () => api(`/applications/${id}/prepare`, { method: "POST" }), "Preparing application")} loading={busy === "prep"}>
                  {app.status === "failed" ? "Retry preparation" : "Prepare application"}
                </Button>
              </div>
            )}
          </div>
        )
      }
    >
      {error && <ErrorNote message={error} />}
      {!app && !error && <Spinner />}
      {app && (
        <div className="space-y-7">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={app.status} />
            {app.adapter && <Badge>{app.adapter === "greenhouse" ? "Greenhouse autofill" : "Manual apply"}</Badge>}
            {app.submitMode && <Badge tone={app.submitMode === "live" ? "red" : "green"}>{app.submitMode === "live" ? "Live" : "Dry run"}</Badge>}
            {app.job?.status === "closed" && <Badge tone="red">Posting closed</Badge>}
            {app.job && (
              <a href={app.job.job_url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900">
                Posting <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          {BUSY.includes(app.status) && (
            <div className="flex items-center gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800">
              <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
              {app.status === "preparing" ? "Tailoring your resume and reading the application form…" : "Filling the application in a secure browser…"}
            </div>
          )}
          {app.error && !BUSY.includes(app.status) && (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{app.error}</span>
            </div>
          )}
          {app.confirmationText && (
            <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> Verified: “{app.confirmationText}”
            </div>
          )}

          {app.tailored && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Tailored resume</h4>
                <div className="flex gap-2">
                  <a href={`/api/applications/${app.id}/resume.pdf`} target="_blank" rel="noreferrer">
                    <Button size="sm">
                      <Download className="h-3 w-3" /> PDF
                    </Button>
                  </a>
                  <a href={`/api/applications/${app.id}/resume.docx`}>
                    <Button size="sm">
                      <Download className="h-3 w-3" /> DOCX
                    </Button>
                  </a>
                </div>
              </div>
              <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 p-3 text-sm">
                <div className="mb-2 flex items-center gap-2">
                  <Badge tone={app.tailored.method === "ai" ? "violet" : "zinc"}>{app.tailored.method === "ai" ? "AI-tailored + fabrication guard" : "Deterministic tailoring"}</Badge>
                </div>
                <ul className="space-y-1 text-zinc-600">
                  {app.tailored.changes.map((c) => (
                    <li key={c}>· {c}</li>
                  ))}
                </ul>
                {app.tailored.summary && <p className="mt-3 text-zinc-800">{app.tailored.summary}</p>}
                {app.tailored.matchedKeywords.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {app.tailored.matchedKeywords.map((k) => (
                      <span key={k} className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">
                        {k}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {app.answers.length > 0 && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Application answers</h4>
                {app.missing.length > 0 && <Badge tone="amber">{app.missing.length} required missing</Badge>}
              </div>
              <div className="space-y-4">
                {app.answers.map((a) => {
                  const src = SOURCE_LABEL[a.source];
                  return (
                    <div key={a.key} className={cx("rounded-lg", a.needsReview && "bg-amber-50/50 p-3 ring-1 ring-amber-100")}>
                      <div className="mb-1.5 flex items-start justify-between gap-3">
                        <span className="text-sm font-medium text-zinc-800">
                          {a.label}
                          {a.required && <span className="text-red-500"> *</span>}
                        </span>
                        <Badge tone={src.tone}>{src.label}</Badge>
                      </div>
                      {fieldByKey.get(a.key)?.description && <p className="mb-1.5 line-clamp-3 text-xs text-zinc-500">{fieldByKey.get(a.key)!.description}</p>}
                      <AnswerInput
                        answer={a}
                        field={fieldByKey.get(a.key)}
                        value={values[a.key] ?? a.value}
                        disabled={!editable}
                        onChange={(v) => {
                          setValues((s) => ({ ...s, [a.key]: v }));
                          setDirty(true);
                        }}
                      />
                      {a.note && <p className="mt-1 text-xs text-zinc-500">{a.note}</p>}
                    </div>
                  );
                })}
              </div>
              {editable && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs text-zinc-600">
                    <input type="checkbox" className="rounded border-zinc-300" checked={saveToLibrary} onChange={(e) => setSaveToLibrary(e.target.checked)} />
                    Remember edited answers for future applications
                  </label>
                  <Button variant={dirty || needsReview ? "primary" : "secondary"} onClick={saveAnswers} loading={busy === "save"}>
                    {needsReview && !dirty ? "Confirm answers" : "Save answers"}
                  </Button>
                </div>
              )}
            </section>
          )}

          {app.hasScreenshot && (
            <a href={`/api/applications/${app.id}/screenshot`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-zinc-600 hover:text-zinc-900">
              <Image className="h-4 w-4" /> View last browser screenshot
            </a>
          )}

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Tracking</h4>
            <div className="flex flex-wrap gap-2">
              {TRACK_ACTIONS.filter((t) => t.from.includes(app.status)).map((t) => (
                <Button key={t.to} size="sm" onClick={() => setStatus(t.to)} loading={busy === t.to}>
                  {t.label}
                </Button>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <input className={inputCls} placeholder="Private note (recruiter name, next steps…)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button onClick={() => run("note", () => api(`/applications/${id}/notes`, { method: "POST", json: { note } }), "Note saved")} disabled={!note.trim()} loading={busy === "note"}>
                Save
              </Button>
            </div>
          </section>

          <section>
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">History</h4>
            <ol className="relative space-y-4 border-l border-zinc-200 pl-4">
              {app.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <span className={cx("absolute -left-[4.5px] mt-1.5 h-2 w-2 rounded-full", e.type === "error" ? "bg-red-500" : e.type === "status" ? "bg-zinc-800" : "bg-zinc-300")} />
                  <div className="flex items-center gap-2">
                    {e.to_status && <StatusBadge status={e.to_status} />}
                    <span className="text-xs text-zinc-400">{timeAgo(e.created_at)}</span>
                  </div>
                  {e.message && <p className="mt-1 text-zinc-600">{e.message}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Drawer>
  );
}
