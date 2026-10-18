import { ArrowLeft, ArrowRight, FileUp, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SENIORITY_ORDER, type BaseResume, type PersonalInfo, type Preferences, type Seniority } from "../../shared/types";
import { api, useApi } from "../api";
import { useLocale, useT } from "../i18n";
import { Button, Card, cx, Field, inputCls, TagInput, Toggle, useToast } from "../ui";
import { CompanyPicker } from "./CompanyPicker";

interface ImportResult {
  draft: BaseResume | null;
  text: string;
  method: "ai" | "text-only";
  note?: string;
  contact: Partial<PersonalInfo>;
  suggested: { targetTitles: string[]; seniority: Seniority[]; years: number } | null;
}

const SENIORITY_VI: Record<Seniority, string> = {
  intern: "Thực tập",
  junior: "Junior",
  mid: "Mid",
  senior: "Senior",
  staff: "Staff",
  principal: "Principal",
  manager: "Quản lý",
  director: "Giám đốc",
  executive: "Lãnh đạo",
};

function Steps({ step }: { step: number }) {
  const t = useT();
  const labels = [t("Resume", "Resume"), t("Mong muốn", "Preferences"), t("Công ty", "Companies")];
  return (
    <div className="mb-8 flex items-center gap-2">
      {labels.map((l, i) => (
        <div key={l} className="flex flex-1 items-center gap-2">
          <span className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", i <= step ? "bg-zinc-900 text-white" : "bg-zinc-200 text-zinc-500")}>{i + 1}</span>
          <span className={cx("text-sm", i === step ? "font-medium text-zinc-900" : "text-zinc-500")}>{l}</span>
          {i < labels.length - 1 && <span className="h-px flex-1 bg-zinc-200" />}
        </div>
      ))}
    </div>
  );
}

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const toast = useToast();
  const { data: profile } = useApi<{ personal: PersonalInfo; preferences: Preferences }>("/profile");
  const [step, setStep] = useState(0);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [personal, setPersonal] = useState<Partial<PersonalInfo>>({});
  const [authorized, setAuthorized] = useState(true);
  const [prefs, setPrefs] = useState({ targetTitles: [] as string[], seniority: [] as Seniority[], workplace: "any" as Preferences["workplace"], minSalary: null as number | null, salaryCurrency: "USD" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [finishing, setFinishing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: existing } = useApi<{ resume: BaseResume }>("/resume");
  // Prefill from whatever is already saved (e.g. when re-running setup or skipping the upload).
  useEffect(() => {
    if (!profile) return;
    const pp = profile.personal;
    setPersonal((p) => ({
      ...Object.fromEntries(Object.entries({ email: pp.email, firstName: pp.firstName, lastName: pp.lastName, phone: pp.phone, city: pp.city, country: pp.country, linkedin: pp.linkedin, github: pp.github }).filter(([, v]) => v)),
      ...p,
    }));
    setAuthorized(!pp.requiresSponsorship);
    const pr = profile.preferences;
    setPrefs((s) => ({
      ...s,
      targetTitles: s.targetTitles.length ? s.targetTitles : pr.targetTitles,
      seniority: s.seniority.length ? s.seniority : pr.seniority,
      workplace: pr.workplace,
      minSalary: pr.minSalary,
      salaryCurrency: pr.salaryCurrency,
    }));
  }, [profile]);
  useEffect(() => {
    if (!existing?.resume.experience.length) return;
    setPrefs((s) => (s.targetTitles.length ? s : { ...s, targetTitles: [...new Set(existing.resume.experience.slice(0, 2).map((e) => e.title).filter(Boolean))] }));
  }, [existing]);

  const onFile = async (file: File) => {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api<ImportResult>("/resume/import", { method: "POST", body: fd });
      setImported(res);
      if (res.draft) await api("/resume", { method: "PUT", json: res.draft });
      setPersonal((p) => ({ ...p, ...Object.fromEntries(Object.entries(res.contact).filter(([, v]) => v)) }));
      if (res.suggested) setPrefs((p) => ({ ...p, targetTitles: res.suggested!.targetTitles, seniority: res.suggested!.seniority }));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const finish = async (skip = false) => {
    setFinishing(true);
    try {
      if (!skip && selected.size) await api("/sources/catalog", { method: "POST", json: { ids: [...selected] } });
      const country = personal.country?.trim();
      await api("/onboarding/complete", {
        method: "POST",
        json: skip
          ? { locale, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
          : {
              locale,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              personal: { ...personal, requiresSponsorship: !authorized, workAuthorizedCountries: authorized && country ? [country] : [] },
              preferences: {
                ...prefs,
                locations: [personal.city, country].filter((x): x is string => !!x?.trim()),
              },
            },
      });
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
      setFinishing(false);
    }
  };

  const p = (k: keyof PersonalInfo, label: string, placeholder?: string) => (
    <Field label={label}>
      <input className={inputCls} placeholder={placeholder} value={(personal[k] as string) ?? ""} onChange={(e) => setPersonal((s) => ({ ...s, [k]: e.target.value }))} />
    </Field>
  );

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-8">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900">
              <svg viewBox="0 0 32 32" className="h-5 w-5">
                <path d="M9 21.5 16 8l7 13.5-7-3.2-7 3.2Z" fill="#fff" />
              </svg>
            </div>
            <span className="text-sm font-semibold">ApplyPilot</span>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setLocale(locale === "vi" ? "en" : "vi")} className="text-xs font-medium text-zinc-500 hover:text-zinc-900">
              {locale === "vi" ? "English" : "Tiếng Việt"}
            </button>
            <button onClick={() => finish(true)} className="text-xs text-zinc-400 hover:text-zinc-700">
              {t("Bỏ qua, thiết lập sau", "Skip for now")}
            </button>
          </div>
        </div>
        <Steps step={step} />

        {step === 0 && (
          <Card className="p-8">
            <h1 className="text-xl font-semibold tracking-tight">{t("Bắt đầu với resume của bạn", "Start with your resume")}</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {t("ApplyPilot đọc resume để tìm việc phù hợp và điền hồ sơ thay bạn. Nó không bao giờ thêm kinh nghiệm bạn không có.", "ApplyPilot reads your resume to find matching jobs and fill applications. It never adds experience you don't have.")}
            </p>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            {!imported ? (
              <button
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files[0];
                  if (f) void onFile(f);
                }}
                disabled={importing}
                className="mt-6 flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50/50 px-6 py-12 text-sm text-zinc-500 transition hover:border-zinc-300"
              >
                {importing ? <Loader2 className="h-6 w-6 animate-spin" /> : <FileUp className="h-6 w-6" />}
                <span className="font-medium text-zinc-700">{importing ? t("Đang đọc resume…", "Reading your resume…") : t("Kéo thả hoặc bấm để chọn file", "Drop a file or click to choose")}</span>
                <span className="text-xs">PDF, DOCX, TXT</span>
              </button>
            ) : (
              <div className="mt-6 rounded-xl bg-emerald-50/60 p-4 text-sm">
                <div className="font-medium text-emerald-900">
                  {imported.draft
                    ? t(`Đã đọc: ${imported.draft.experience.length} vị trí, ${imported.draft.skills.length} kỹ năng`, `Read: ${imported.draft.experience.length} roles, ${imported.draft.skills.length} skills`)
                    : t("Đã trích xuất văn bản — bạn có thể hoàn thiện resume sau trong mục “Tôi”.", "Text extracted — you can finish your resume later under “Me”.")}
                </div>
                {imported.draft && <div className="mt-1 text-emerald-800">{imported.draft.experience.slice(0, 3).map((e) => `${e.title} @ ${e.company}`).join(" · ")}</div>}
                <button className="mt-2 text-xs text-emerald-900 underline" onClick={() => fileRef.current?.click()}>
                  {t("Chọn file khác", "Choose another file")}
                </button>
              </div>
            )}
            <div className="mt-8 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                <ShieldCheck className="h-3.5 w-3.5" /> {t("Dữ liệu được mã hoá", "Your data is encrypted")}
              </span>
              <Button variant="primary" onClick={() => setStep(1)} disabled={importing}>
                {imported ? t("Tiếp tục", "Continue") : t("Bỏ qua bước này", "Skip this step")} <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </Card>
        )}

        {step === 1 && (
          <Card className="p-8">
            <h1 className="text-xl font-semibold tracking-tight">{t("Bạn đang tìm việc gì?", "What are you looking for?")}</h1>
            <p className="mt-1 text-sm text-zinc-500">{t("Đã điền sẵn từ resume — chỉnh nếu cần.", "Prefilled from your resume — adjust if needed.")}</p>
            <div className="mt-6 space-y-4">
              <Field label={t("Chức danh mong muốn", "Target job titles")}>
                <TagInput value={prefs.targetTitles} onChange={(v) => setPrefs((s) => ({ ...s, targetTitles: v }))} placeholder="Software Engineer, Product Manager…" />
              </Field>
              <Field label={t("Cấp bậc", "Level")}>
                <div className="flex flex-wrap gap-1.5">
                  {SENIORITY_ORDER.map((s) => {
                    const on = prefs.seniority.includes(s);
                    return (
                      <button
                        key={s}
                        onClick={() => setPrefs((x) => ({ ...x, seniority: on ? x.seniority.filter((y) => y !== s) : [...x.seniority, s] }))}
                        className={cx("rounded-md border px-2.5 py-1.5 text-xs", on ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700")}
                      >
                        {locale === "vi" ? SENIORITY_VI[s] : s[0]!.toUpperCase() + s.slice(1)}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                {p("city", t("Thành phố của bạn", "Your city"), "San Francisco")}
                {p("country", t("Quốc gia", "Country"), "United States")}
                <Field label={t("Hình thức làm việc", "Workplace")}>
                  <select className={inputCls} value={prefs.workplace} onChange={(e) => setPrefs((s) => ({ ...s, workplace: e.target.value as Preferences["workplace"] }))}>
                    <option value="any">{t("Bất kỳ", "Any")}</option>
                    <option value="remote_or_hybrid">{t("Remote hoặc hybrid", "Remote or hybrid")}</option>
                    <option value="remote_only">{t("Chỉ remote", "Remote only")}</option>
                  </select>
                </Field>
                <Field label={t("Lương tối thiểu / năm (tuỳ chọn)", "Minimum salary / year (optional)")}>
                  <div className="flex gap-2">
                    <input type="number" className={inputCls} value={prefs.minSalary ?? ""} placeholder="120000" onChange={(e) => setPrefs((s) => ({ ...s, minSalary: e.target.value ? Number(e.target.value) : null }))} />
                    <select className={cx(inputCls, "w-24")} value={prefs.salaryCurrency} onChange={(e) => setPrefs((s) => ({ ...s, salaryCurrency: e.target.value }))}>
                      {["USD", "EUR", "GBP", "CAD", "AUD"].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </Field>
              </div>
              <div className="rounded-lg border border-zinc-200 p-4">
                <Toggle
                  checked={authorized}
                  onChange={setAuthorized}
                  label={t(`Tôi được phép làm việc tại ${personal.country || "quốc gia của mình"} mà không cần bảo lãnh visa`, `I can work in ${personal.country || "my country"} without visa sponsorship`)}
                  description={t("Nếu tắt, việc ghi rõ “không bảo lãnh visa” sẽ được ẩn.", "If off, jobs that say they don't sponsor visas are hidden.")}
                />
              </div>
              <details className="rounded-lg border border-zinc-100 p-3 text-sm">
                <summary className="cursor-pointer text-zinc-600">{t("Thông tin liên hệ dùng khi nộp hồ sơ", "Contact details used in applications")}</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {p("firstName", t("Tên", "First name"))}
                  {p("lastName", t("Họ", "Last name"))}
                  {p("email", "Email")}
                  {p("phone", t("Điện thoại", "Phone"))}
                  {p("linkedin", "LinkedIn")}
                  {p("github", "GitHub / Website")}
                </div>
              </details>
            </div>
            <div className="mt-8 flex justify-between">
              <Button variant="ghost" onClick={() => setStep(0)}>
                <ArrowLeft className="h-3.5 w-3.5" /> {t("Quay lại", "Back")}
              </Button>
              <Button variant="primary" onClick={() => setStep(2)}>
                {t("Tiếp tục", "Continue")} <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </Card>
        )}

        {step === 2 && (
          <Card className="p-8">
            <h1 className="text-xl font-semibold tracking-tight">{t("Bạn muốn làm ở đâu?", "Where would you like to work?")}</h1>
            <p className="mt-1 mb-6 text-sm text-zinc-500">
              {t("Chọn các công ty để theo dõi. ApplyPilot kiểm tra việc mới mỗi 6 giờ.", "Pick companies to follow. ApplyPilot checks for new jobs every 6 hours.")}
            </p>
            <CompanyPicker
              selected={selected}
              onToggle={(id) =>
                setSelected((s) => {
                  const n = new Set(s);
                  if (n.has(id)) n.delete(id);
                  else n.add(id);
                  return n;
                })
              }
            />
            <div className="mt-8 flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>
                <ArrowLeft className="h-3.5 w-3.5" /> {t("Quay lại", "Back")}
              </Button>
              <div className="flex items-center gap-3">
                <span className="text-sm text-zinc-500">{t(`Đã chọn ${selected.size}`, `${selected.size} selected`)}</span>
                <Button variant="primary" onClick={() => finish()} loading={finishing}>
                  {t("Bắt đầu tìm việc", "Start finding jobs")} <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
