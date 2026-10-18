import { AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronDown, Copy, Download, ExternalLink, FlaskConical, Image, Send, ShieldCheck, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { AppStatus, FormField, PreparedAnswer, TailoredResume } from "../../shared/types";
import { useMe } from "../App";
import { api, useApi } from "../api";
import { timeAgoT, useT } from "../i18n";
import { Badge, Button, Card, cx, ErrorNote, inputCls, Modal, Spinner, StatusBadge, useStatusLabel, useToast } from "../ui";

interface Detail {
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
  clicked: boolean;
  hasResume: boolean;
  answers: PreparedAnswer[];
  missing: string[];
  form: FormField[];
  quality: { score: number; blocking: number; warnings: number; checks: QualityCheck[] } | null;
  tailored: TailoredResume | null;
  job: { id: string; title: string; company: string; location: string | null; job_url: string; apply_url: string; status: string } | null;
  events: { id: number; type: string; to_status: AppStatus | null; message: string | null; created_at: number }[];
  globalSubmitMode: "dry_run" | "live";
}

interface QualityCheck {
  id: string;
  ok: boolean;
  severity: "block" | "warn" | "info";
  message: string;
  field?: string;
}

const AUTOMATED = new Set(["greenhouse", "ashby"]);
const BUSY: AppStatus[] = ["preparing", "approved", "submitting"];
const isEmpty = (v: string | string[]) => (Array.isArray(v) ? v.length === 0 : !v.trim());

function AnswerInput({ answer, field, value, onChange, disabled }: { answer: PreparedAnswer; field?: FormField; value: string | string[]; onChange: (v: string | string[]) => void; disabled: boolean }) {
  const t = useT();
  if (answer.type === "file") {
    return <div className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">{answer.key === "resume" ? t("Resume đã điều chỉnh sẽ được đính kèm tự động", "Your tailored resume is attached automatically") : t("Tải lên trực tiếp trên trang tuyển dụng", "Upload this on the employer's site")}</div>;
  }
  const options = field?.options ?? [];
  if (options.length && (answer.type === "select" || answer.type === "multiselect")) {
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
                className={cx("rounded-md border px-2.5 py-1.5 text-xs", on ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50")}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    // Few options → big buttons (faster than a dropdown); many → select.
    if (options.length <= 4) {
      const cur = Array.isArray(value) ? value[0] : value;
      return (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              type="button"
              disabled={disabled}
              key={o.value}
              onClick={() => onChange(o.label)}
              className={cx("rounded-lg border px-3 py-2 text-sm", cur === o.label ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50")}
            >
              {o.label}
            </button>
          ))}
        </div>
      );
    }
    return (
      <select className={inputCls} value={Array.isArray(value) ? (value[0] ?? "") : value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{t("— Chọn —", "— Select —")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.label}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  const v = Array.isArray(value) ? value.join(", ") : value;
  if (answer.type === "date") return <input type="date" className={inputCls} value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
  return answer.type === "textarea" ? (
    <textarea className={cx(inputCls, "min-h-[120px]")} value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
  ) : (
    <input className={inputCls} value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
  );
}

function QualityCard({ q }: { q: NonNullable<Detail["quality"]> }) {
  const t = useT();
  const tail = (m: string) => m.split(": ").slice(1).join(": ") || m;
  const text = (c: QualityCheck) => {
    const vi: Record<string, string> = {
      required: `Câu bắt buộc chưa trả lời: ${c.field ?? ""}`,
      option: `${c.field}: lựa chọn không hợp lệ`,
      placeholder: `${c.field}: còn chữ giữ chỗ (ví dụ [Company])`,
      length: `${c.field}: quá dài cho ô một dòng`,
      short: `${c.field}: câu trả lời quá ngắn`,
      claims: `${c.field}: nhắc tới điều không có trong resume — ${tail(c.message)}`,
      relevance: `${c.field}: có thể chưa trả lời đúng câu hỏi`,
      duplicate: `${c.field}: trùng với câu trả lời khác`,
      fabrication: c.ok ? "Resume chỉ chứa thông tin từ bản gốc của bạn" : `Resume: ${tail(c.message)}`,
      contact: c.message.includes("email") ? "Hồ sơ thiếu email" : "Hồ sơ thiếu số điện thoại",
      keywords: c.message.replace(/Covers (\d+) of the job's keywords/, "Bao phủ $1 từ khoá của tin tuyển dụng"),
      answers: c.message.replace(/(\d+) answers checked/, "Đã kiểm tra $1 câu trả lời"),
    };
    return t(vi[c.id] ?? c.message, c.field && !c.message.includes(c.field) ? `${c.field}: ${c.message}` : c.message);
  };
  const problems = q.checks.filter((c) => !c.ok);
  const passed = q.checks.filter((c) => c.ok);
  const tone = q.blocking ? "border-red-200 bg-red-50/40" : q.warnings ? "border-amber-200 bg-amber-50/30" : "border-emerald-200 bg-emerald-50/30";
  return (
    <Card className={tone}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("Kiểm tra chất lượng", "Quality check")}</h2>
        <span className={cx("rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums", q.blocking ? "bg-red-600 text-white" : q.warnings ? "bg-amber-500 text-white" : "bg-emerald-600 text-white")}>
          {q.blocking ? t(`${q.blocking} mục cần sửa`, `${q.blocking} to fix`) : `${q.score}/100`}
        </span>
      </div>
      {problems.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {problems.map((c, i) => (
            <li key={i} className={cx("flex gap-2", c.severity === "block" ? "text-red-700" : "text-amber-800")}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{text(c)}</span>
            </li>
          ))}
        </ul>
      )}
      {passed.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-emerald-800">
          {passed.map((c, i) => (
            <li key={i} className="flex gap-1.5">
              <Check className="h-3.5 w-3.5 shrink-0" /> {text(c)}
            </li>
          ))}
        </ul>
      )}
      {q.blocking > 0 && <p className="mt-3 text-xs text-red-700">{t("Cần sửa các mục màu đỏ trước khi duyệt.", "Fix the red items before approving.")}</p>}
    </Card>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />} {done ? t("Đã chép", "Copied") : t("Chép", "Copy")}
    </Button>
  );
}

export default function ReviewScreen() {
  const t = useT();
  const statusLabel = useStatusLabel();
  const toast = useToast();
  const navigate = useNavigate();
  const { id } = useParams();
  const { me } = useMe();
  const [poll, setPoll] = useState(0);
  const { data: app, error, reload } = useApi<Detail>(id ? `/applications/${id}` : null, { pollMs: poll });
  const { data: queue } = useApi<{ items: { id: string; status: AppStatus }[] }>("/applications?status=prepared,needs_manual");
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [confirm, setConfirm] = useState<null | "dry_run" | "live">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [notSubmittedOk, setNotSubmittedOk] = useState(false);
  const pending = useRef<Record<string, string | string[]>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setValues({});
    pending.current = {};
  }, [id]);
  useEffect(() => {
    if (!app) return;
    setPoll(BUSY.includes(app.status) ? 4000 : 0);
    setValues((cur) => ({ ...Object.fromEntries(app.answers.map((a) => [a.key, a.value])), ...cur, ...pending.current }));
    setNote(app.notes ?? "");
  }, [app]);

  const flush = useCallback(async () => {
    const changes = pending.current;
    if (!id || !Object.keys(changes).length) return;
    pending.current = {};
    setSaving("saving");
    try {
      await api(`/applications/${id}/answers`, { method: "PUT", json: { answers: Object.entries(changes).map(([key, value]) => ({ key, value })), saveToLibrary: true } });
      setSaving("saved");
      void reload(true); // refresh the quality report
    } catch (e) {
      pending.current = { ...changes, ...pending.current };
      setSaving("idle");
      toast((e as Error).message, "error");
    }
  }, [id, toast, reload]);

  const onChange = (key: string, v: string | string[]) => {
    setValues((s) => ({ ...s, [key]: v }));
    pending.current[key] = v;
    setSaving("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 900);
  };

  const run = async (label: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try {
      await fn();
      toast(success);
      await reload(true);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  if (error) return <ErrorNote message={error} />;
  if (!app) return <Spinner />;

  const editable = ["prepared", "needs_manual", "failed"].includes(app.status) && app.answers.length > 0;
  const automated = AUTOMATED.has(app.adapter ?? "");
  const fieldByKey = new Map(app.form.map((f) => [f.key, f]));
  const val = (a: PreparedAnswer) => values[a.key] ?? a.value;
  const needsYou = app.answers.filter((a) => a.needsReview || (a.required && isEmpty(val(a))));
  const autoFilled = app.answers.filter((a) => !needsYou.includes(a));
  const missingNow = app.answers.filter((a) => a.required && isEmpty(val(a)) && a.type !== "file");
  const aiCount = app.answers.filter((a) => a.source === "ai").length;
  const liveAvailable = me?.submitMode === "live" && me.liveSubmitEnabled;
  const others = (queue?.items ?? []).filter((x) => x.id !== app.id);
  const next = others[0]?.id;

  const approve = async (mode: "dry_run" | "live") => {
    if (timer.current) clearTimeout(timer.current);
    setBusy(mode);
    try {
      await api(`/applications/${app.id}/approve`, {
        method: "POST",
        json: {
          mode,
          confirm: true,
          confirmNotSubmitted: app.clicked && notSubmittedOk,
          answers: Object.entries({ ...values, ...pending.current }).map(([key, value]) => ({ key, value })),
        },
      });
      pending.current = {};
      setConfirm(null);
      toast(mode === "live" ? t("Đã duyệt — đang nộp", "Approved — submitting") : t("Đang chạy thử — form được điền nhưng không nộp", "Dry run started — the form is filled but not submitted"));
      await reload(true);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };
  const setStatus = (status: AppStatus) => run(status, () => api(`/applications/${app.id}/status`, { method: "POST", json: { status, note: "" } }), statusLabel(status));

  // Server notes are stable English strings; show them in the UI language.
  const noteText = (note: string) =>
    ({
      "Attestation — please answer this yourself": t("Cam kết / xác nhận — bạn cần tự trả lời", note),
      "Personal answer — only you can answer this (it will be remembered if you save it)": t("Câu hỏi cá nhân — chỉ bạn trả lời được (sẽ được nhớ cho lần sau)", note),
      "Pick a date (YYYY-MM-DD)": t("Chọn ngày", "Pick a date"),
      "Upload not supported automatically": t("Tải lên trực tiếp trên trang tuyển dụng", note),
      "AI draft — review before approving": t("AI soạn — đọc lại trước khi duyệt", note),
    })[note] ?? note;

  const renderAnswer = (a: PreparedAnswer) => {
    const field = fieldByKey.get(a.key);
    const sourceLabel: Record<PreparedAnswer["source"], string> = {
      profile: t("Từ hồ sơ", "Profile"),
      library: t("Câu đã lưu", "Saved answer"),
      ai: t("AI soạn — hãy đọc lại", "AI draft — read it"),
      default: t("Mặc định", "Default"),
      user: t("Bạn", "You"),
      file: t("Tệp", "File"),
      none: t("Chưa có", "Empty"),
    };
    return (
      <div key={a.key}>
        <div className="mb-1.5 flex items-start justify-between gap-3">
          <span className="text-sm font-medium text-zinc-800">
            {a.label}
            {a.required && <span className="text-red-500"> *</span>}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {!automated && !isEmpty(val(a)) && a.type !== "file" && <CopyButton text={Array.isArray(val(a)) ? (val(a) as string[]).join(", ") : (val(a) as string)} />}
            <Badge tone={a.source === "ai" ? "violet" : a.source === "none" ? "amber" : a.source === "user" ? "green" : "zinc"}>{sourceLabel[a.source]}</Badge>
          </div>
        </div>
        {field?.description && <p className="mb-1.5 line-clamp-3 text-xs text-zinc-500">{field.description}</p>}
        <AnswerInput answer={a} field={field} value={val(a)} disabled={!editable} onChange={(v) => onChange(a.key, v)} />
        {a.note && <p className="mt-1 text-xs text-zinc-500">{noteText(a.note)}</p>}
      </div>
    );
  };

  return (
    <div className="pb-28">
      <div className="mb-4 flex items-center justify-between gap-2">
        <Link to="/applications" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900">
          <ArrowLeft className="h-4 w-4" /> {t("Hồ sơ ứng tuyển", "Applications")}
        </Link>
        {next && (
          <Button size="sm" variant="ghost" onClick={() => navigate(`/review/${next}`)}>
            {t(`Hồ sơ tiếp theo (${others.length})`, `Next (${others.length})`)} <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{app.job?.title}</h1>
          <StatusBadge status={app.status} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-zinc-500">
          <span>{[app.job?.company, app.job?.location].filter(Boolean).join(" · ")}</span>
          {app.job && (
            <a href={app.job.job_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-zinc-900">
              {t("Tin tuyển dụng", "Posting")} <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      <div className="space-y-5">
        {BUSY.includes(app.status) && (
          <div className="flex items-center gap-2 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-800">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
            {app.status === "preparing"
              ? t("Đang điều chỉnh resume và đọc form ứng tuyển… (khoảng 1 phút)", "Tailoring your resume and reading the application form… (about a minute)")
              : t("Đang điền form trong trình duyệt an toàn…", "Filling the form in a secure browser…")}
          </div>
        )}
        {app.confirmationText && (
          <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> {t("Đã xác nhận nộp thành công", "Submission confirmed")}: “{app.confirmationText}”
          </div>
        )}
        {app.error && !BUSY.includes(app.status) && app.status !== "prepared" && (
          <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{app.error}</span>
          </div>
        )}

        {(app.status === "shortlisted" || (app.status === "failed" && !app.answers.length)) && (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-zinc-600">{t("ApplyPilot sẽ điều chỉnh resume và soạn câu trả lời cho việc này.", "ApplyPilot will tailor your resume and draft answers for this job.")}</p>
              <Button variant="primary" onClick={() => run("prep", () => api(`/applications/${app.id}/prepare`, { method: "POST" }), t("Đang chuẩn bị", "Preparing"))} loading={busy === "prep"}>
                <Sparkles className="h-3.5 w-3.5" /> {app.status === "failed" ? t("Thử lại", "Try again") : t("Chuẩn bị hồ sơ", "Prepare application")}
              </Button>
            </div>
          </Card>
        )}

        {app.quality && ["prepared", "needs_manual", "failed"].includes(app.status) && <QualityCard q={app.quality} />}

        {app.answers.length > 0 && (
          <Card>
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {needsYou.length ? t(`${needsYou.length} câu cần bạn xem`, `${needsYou.length} question(s) need you`) : t("Tất cả câu đã sẵn sàng", "All answers are ready")}
              </h2>
              <span className="text-xs text-zinc-400">{saving === "saving" ? t("Đang lưu…", "Saving…") : saving === "saved" ? t("Đã lưu", "Saved") : ""}</span>
            </div>
            {needsYou.length > 0 ? <div className="space-y-5">{needsYou.map(renderAnswer)}</div> : <p className="text-sm text-zinc-500">{t("Không có câu nào cần bạn trả lời.", "Nothing needs your input.")}</p>}
            {autoFilled.length > 0 && (
              <details className="group mt-5 rounded-lg border border-zinc-100">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm text-zinc-600">
                  {t(`${autoFilled.length} câu đã điền tự động từ hồ sơ của bạn`, `${autoFilled.length} answers filled automatically from your profile`)}
                  <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
                </summary>
                <div className="space-y-5 border-t border-zinc-100 px-3 py-4">{autoFilled.map(renderAnswer)}</div>
              </details>
            )}
          </Card>
        )}

        {app.tailored && (
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{t("Resume cho việc này", "Resume for this job")}</h2>
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
            <ul className="space-y-1 text-sm text-zinc-600">
              {app.tailored.changes.map((c) => (
                <li key={c}>· {c}</li>
              ))}
            </ul>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              {t("Chỉ dùng nội dung bạn đã viết — không thêm kinh nghiệm hay con số.", "Only your own content — no added experience or numbers.")}
            </p>
          </Card>
        )}

        {!automated && ["prepared", "needs_manual"].includes(app.status) && (
          <Card className="border-sky-200">
            <h2 className="text-sm font-semibold">{t("Nộp hỗ trợ", "Assisted apply")}</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-600">
              <li>{t("Mở form ứng tuyển (tab mới).", "Open the application form (new tab).")}</li>
              <li>{t("Tải resume PDF ở trên và chép từng câu trả lời bằng nút “Chép”.", "Attach the PDF above and copy each answer with “Copy”.")}</li>
              <li>{t("Bấm nộp trên trang đó, rồi quay lại bấm “Tôi đã nộp”.", "Submit on that page, then come back and click “I applied”.")}</li>
            </ol>
            <p className="mt-2 text-xs text-zinc-500">
              {t("Trang này dùng CAPTCHA hoặc chưa có tự động hoá, nên ApplyPilot không tự bấm nộp.", "This site uses CAPTCHA or has no automation, so ApplyPilot never clicks submit here.")}
            </p>
          </Card>
        )}

        {app.hasScreenshot && (
          <a href={`/api/applications/${app.id}/screenshot`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-zinc-600 hover:text-zinc-900">
            <Image className="h-4 w-4" /> {t("Xem ảnh chụp form lần chạy gần nhất", "View the latest form screenshot")}
          </a>
        )}

        <details className="group rounded-xl border border-zinc-200/80 bg-white">
          <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-semibold">
            {t("Theo dõi & lịch sử", "Tracking & history")}
            <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
          </summary>
          <div className="space-y-4 border-t border-zinc-100 px-5 py-4">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["interview", ["submitted", "rejected"]],
                  ["offered", ["submitted", "interview"]],
                  ["rejected", ["submitted", "interview", "offered"]],
                  ["withdrawn", ["shortlisted", "prepared", "needs_manual", "failed", "submitted", "interview", "offered"]],
                ] as [AppStatus, AppStatus[]][]
              )
                .filter(([, from]) => from.includes(app.status))
                .map(([to]) => (
                  <Button key={to} size="sm" onClick={() => setStatus(to)} loading={busy === to}>
                    {statusLabel(to)}
                  </Button>
                ))}
            </div>
            <div className="flex gap-2">
              <input className={inputCls} placeholder={t("Ghi chú riêng (tên recruiter, bước tiếp theo…)", "Private note (recruiter, next steps…)")} value={note} onChange={(e) => setNote(e.target.value)} />
              <Button onClick={() => run("note", () => api(`/applications/${app.id}/notes`, { method: "POST", json: { note } }), t("Đã lưu ghi chú", "Note saved"))} disabled={!note.trim()} loading={busy === "note"}>
                {t("Lưu", "Save")}
              </Button>
            </div>
            <ol className="space-y-2 text-sm">
              {app.events.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className="w-24 shrink-0 text-xs text-zinc-400">{timeAgoT(t, e.created_at)}</span>
                  <span className="text-zinc-600">
                    {e.to_status && <span className="font-medium text-zinc-800">{statusLabel(e.to_status)} · </span>}
                    {e.message}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </details>
      </div>

      {/* Sticky action bar */}
      {["prepared", "needs_manual"].includes(app.status) && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white/95 backdrop-blur lg:left-60">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-8">
            <span className="text-xs text-zinc-500">
              {missingNow.length
                ? t(`Còn ${missingNow.length} câu bắt buộc chưa trả lời`, `${missingNow.length} required question(s) left`)
                : automated
                  ? t("Sẵn sàng. Không có gì được gửi khi chưa có bạn xác nhận.", "Ready. Nothing is sent until you confirm.")
                  : t("Nộp trên trang tuyển dụng, rồi đánh dấu đã nộp.", "Apply on the employer's site, then mark it applied.")}
            </span>
            <div className="flex gap-2">
              {automated && app.status === "prepared" ? (
                <>
                  <Button onClick={() => setConfirm("dry_run")} disabled={missingNow.length > 0}>
                    <FlaskConical className="h-3.5 w-3.5" /> {t("Chạy thử", "Dry run")}
                  </Button>
                  {liveAvailable && (
                    <Button variant="primary" onClick={() => setConfirm("live")} disabled={missingNow.length > 0}>
                      <Send className="h-3.5 w-3.5" /> {t("Duyệt & nộp", "Approve & submit")}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  {automated && app.status === "needs_manual" && (
                    <Button
                      variant="ghost"
                      onClick={() => run("retry", () => api(`/applications/${app.id}/status`, { method: "POST", json: { status: "prepared", note: "Retry requested" } }), t("Đã mở lại để duyệt", "Reopened for review"))}
                      loading={busy === "retry"}
                    >
                      {t("Thử lại", "Retry")}
                    </Button>
                  )}
                  <a href={app.job?.apply_url} target="_blank" rel="noreferrer">
                    <Button>
                      {t("Mở form", "Open form")} <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </a>
                  <Button variant="primary" onClick={() => setStatus("submitted")} loading={busy === "submitted"}>
                    <Check className="h-3.5 w-3.5" /> {t("Tôi đã nộp", "I applied")}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm === "live" ? t("Nộp hồ sơ này?", "Submit this application?") : t("Chạy thử hồ sơ này?", "Dry-run this application?")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("Xem lại", "Go back")}
            </Button>
            <Button variant="primary" onClick={() => confirm && approve(confirm)} loading={busy === confirm} disabled={confirm === "live" && app.clicked && !notSubmittedOk}>
              {confirm === "live" ? t("Xác nhận & nộp", "Confirm & submit") : t("Chạy thử", "Run dry run")}
            </Button>
          </>
        }
      >
        <ul className="space-y-1.5">
          <li>
            · <span className="font-medium">{app.job?.title}</span> — {app.job?.company}
          </li>
          <li>· {t(`Resume: ${app.tailorMethod === "ai" ? "điều chỉnh bằng AI (đã kiểm tra không bịa)" : "sắp xếp lại theo việc"}`, `Resume: ${app.tailorMethod === "ai" ? "AI-tailored (fabrication-checked)" : "reordered for the job"}`)}</li>
          <li>· {t(`${app.answers.length} câu trả lời${aiCount ? `, ${aiCount} do AI soạn` : ""}`, `${app.answers.length} answers${aiCount ? `, ${aiCount} drafted by AI` : ""}`)}</li>
        </ul>
        {confirm === "live" && app.clicked && (
          <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
            <input type="checkbox" className="mt-0.5" checked={notSubmittedOk} onChange={(e) => setNotSubmittedOk(e.target.checked)} />
            {t(
              "Lần trước đã bấm nộp nhưng không xác nhận được. Tôi đã kiểm tra email / trang tuyển dụng và chắc chắn hồ sơ CHƯA được nộp.",
              "An earlier attempt clicked submit but couldn't be verified. I checked my email / the employer site and I'm sure it was NOT submitted.",
            )}
          </label>
        )}
        <p className="mt-3 text-zinc-600">
          {confirm === "live"
            ? t("Bằng việc xác nhận, bạn xác nhận đã đọc các câu trả lời và chúng chính xác. ApplyPilot sẽ điền form và bấm nộp một lần, rồi kiểm tra trang xác nhận.", "By confirming you agree you've read the answers and they're accurate. ApplyPilot fills the form, clicks submit once, and checks for confirmation.")
            : t("Form sẽ được điền trong trình duyệt và chụp màn hình. Mọi yêu cầu gửi đi đều bị chặn — nhà tuyển dụng không nhận được gì.", "The form is filled in a browser and screenshotted. Every outgoing request is blocked — the employer receives nothing.")}
        </p>
      </Modal>
    </div>
  );
}
