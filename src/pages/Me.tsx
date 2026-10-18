import { AlertTriangle, Download, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { SENIORITY_ORDER, type PersonalInfo, type Preferences, type UsageSummary, type UserSettings } from "../../shared/types";
import { useMe } from "../App";
import { api, fmtMoney, useApi } from "../api";
import { timeAgoT, useT } from "../i18n";
import { Badge, Button, Card, CardHeader, cx, ErrorNote, Field, inputCls, PageHeader, Progress, Spinner, TagInput, Tabs, Toggle, useToast } from "../ui";
import { CompanyPicker } from "./CompanyPicker";
import Monitoring from "./Monitoring";
import ResumeEditor from "./ResumeEditor";

interface ProfileResponse {
  personal: PersonalInfo;
  preferences: Preferences;
  settings: UserSettings;
  answers: { question: string; answer: string; updatedAt: number }[];
}

type TabId = "resume" | "profile" | "companies" | "automation" | "monitoring" | "data";

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

// ---------------- profile & preferences (one form) ----------------

function EeoSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const mode = value === "" ? "" : value === "decline" ? "decline" : "custom";
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <select className={cx(inputCls, mode === "custom" ? "w-40" : "")} value={mode} onChange={(e) => onChange(e.target.value === "custom" ? " " : e.target.value)}>
          <option value="">{t("Để trống", "Leave blank")}</option>
          <option value="decline">{t("Không muốn trả lời", "Decline to answer")}</option>
          <option value="custom">{t("Câu trả lời cụ thể…", "Specific answer…")}</option>
        </select>
        {mode === "custom" && <input className={inputCls} value={value.trim()} placeholder={t("Đúng chữ của lựa chọn", "Exact option text")} onChange={(e) => onChange(e.target.value || " ")} />}
      </div>
    </Field>
  );
}

function ProfileTab({ data, onSaved }: { data: ProfileResponse; onSaved: () => void }) {
  const t = useT();
  const [p, setP] = useState(data.personal);
  const [pr, setPr] = useState(data.preferences);
  const [lib, setLib] = useState(data.answers.map(({ question, answer }) => ({ question, answer })));
  const { saving, save } = useSaver();
  const set = <K extends keyof PersonalInfo>(k: K, v: PersonalInfo[K]) => setP((x) => ({ ...x, [k]: v }));
  const setPref = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setPr((x) => ({ ...x, [k]: v }));
  const text = (k: keyof PersonalInfo, label: string, placeholder?: string) => (
    <Field label={label}>
      <input className={inputCls} value={p[k] as string} placeholder={placeholder} onChange={(e) => set(k, e.target.value as never)} />
    </Field>
  );

  const saveAll = () =>
    save(
      "all",
      async () => {
        await api("/profile/personal", { method: "PUT", json: { ...p, eeo: Object.fromEntries(Object.entries(p.eeo).map(([k, v]) => [k, v.trim()])) } });
        await api("/profile/preferences", { method: "PUT", json: pr });
        await api("/answers", { method: "PUT", json: { answers: lib } });
      },
      t("Đã lưu — đang chấm điểm lại việc làm", "Saved — re-matching jobs"),
    ).then(onSaved);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t("Mong muốn công việc", "What you're looking for")} subtitle={t("Bộ lọc chạy trước khi chấm điểm, nên việc bị loại không tốn chi phí AI.", "Filters run before scoring, so excluded jobs cost nothing.")} />
        <div className="space-y-4">
          <Field label={t("Chức danh mong muốn", "Target titles")}>
            <TagInput value={pr.targetTitles} onChange={(v) => setPref("targetTitles", v)} placeholder="Backend Engineer, Product Manager" />
          </Field>
          <Field label={t("Cấp bậc", "Level")}>
            <div className="flex flex-wrap gap-1.5">
              {SENIORITY_ORDER.map((s) => {
                const on = pr.seniority.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setPref("seniority", on ? pr.seniority.filter((x) => x !== s) : [...pr.seniority, s])}
                    className={cx("rounded-md border px-2.5 py-1 text-xs capitalize", on ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50")}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Hình thức", "Workplace")}>
              <select className={inputCls} value={pr.workplace} onChange={(e) => setPref("workplace", e.target.value as Preferences["workplace"])}>
                <option value="any">{t("Bất kỳ", "Any")}</option>
                <option value="remote_or_hybrid">{t("Remote hoặc hybrid", "Remote or hybrid")}</option>
                <option value="remote_only">{t("Chỉ remote", "Remote only")}</option>
              </select>
            </Field>
            <Field label={t("Địa điểm ưu tiên", "Preferred locations")} hint={t("Việc remote luôn được giữ lại.", "Remote jobs always pass.")}>
              <TagInput value={pr.locations} onChange={(v) => setPref("locations", v)} placeholder="San Francisco, United States" />
            </Field>
            <Field label={t("Lương tối thiểu / năm", "Minimum salary / year")}>
              <div className="flex gap-2">
                <input type="number" className={inputCls} value={pr.minSalary ?? ""} onChange={(e) => setPref("minSalary", e.target.value ? Number(e.target.value) : null)} />
                <select className={cx(inputCls, "w-24")} value={pr.salaryCurrency} onChange={(e) => setPref("salaryCurrency", e.target.value)}>
                  {["USD", "EUR", "GBP", "CAD", "AUD"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            </Field>
            <Field label={t(`Ẩn việc dưới ${pr.minScore} điểm`, `Hide jobs below ${pr.minScore}`)}>
              <input type="range" min={0} max={90} step={5} value={pr.minScore} onChange={(e) => setPref("minScore", Number(e.target.value))} className="w-full accent-zinc-900" />
            </Field>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-zinc-600">{t("Loại trừ & điều đã học từ bạn", "Exclusions & what ApplyPilot learned")}</summary>
            <div className="mt-3 space-y-3">
              <Field label={t("Loại chức danh chứa", "Exclude titles containing")}>
                <TagInput value={pr.excludeTitleKeywords} onChange={(v) => setPref("excludeTitleKeywords", v)} placeholder="intern, contract" />
              </Field>
              <Field label={t("Công ty đã ẩn", "Hidden companies")}>
                <TagInput value={pr.excludedCompanies} onChange={(v) => setPref("excludedCompanies", v)} />
              </Field>
              <Field label={t("Địa điểm đã ẩn", "Hidden locations")}>
                <TagInput value={pr.excludedLocations} onChange={(v) => setPref("excludedLocations", v)} />
              </Field>
              <Field label={t("Vai trò bạn đã bỏ qua (ít gợi ý hơn)", "Roles you skipped (shown less)")}>
                <TagInput value={pr.learned.disliked} onChange={(v) => setPref("learned", { ...pr.learned, disliked: v })} />
              </Field>
              <Field label={t("Lĩnh vực quan tâm (cộng điểm nhẹ)", "Interests (small score boost)")}>
                <TagInput value={pr.interests} onChange={(v) => setPref("interests", v)} placeholder="developer tools, fintech" />
              </Field>
            </div>
          </details>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("Thông tin liên hệ", "Contact details")} subtitle={t("Được mã hoá và chỉ dùng để điền hồ sơ.", "Encrypted and only used to fill your applications.")} />
        <div className="grid gap-3 sm:grid-cols-2">
          {text("firstName", t("Tên", "First name"))}
          {text("lastName", t("Họ", "Last name"))}
          {text("email", "Email")}
          {text("phone", t("Điện thoại", "Phone"), "+1 415 555 0100")}
          {text("city", t("Thành phố", "City"))}
          {text("country", t("Quốc gia", "Country"))}
          {text("linkedin", "LinkedIn")}
          {text("github", "GitHub")}
          {text("website", t("Website / portfolio", "Website / portfolio"))}
          {text("phoneCountry", t("Quốc gia của số điện thoại", "Phone country"), "United States")}
        </div>
      </Card>

      <Card>
        <CardHeader title={t("Câu trả lời thường gặp", "Common form answers")} subtitle={t("Dùng để trả lời tự động các câu hỏi phổ biến.", "Used to answer common questions automatically.")} />
        <div className="space-y-4">
          <Field label={t("Quốc gia bạn được làm việc không cần bảo lãnh", "Countries you can work in without sponsorship")}>
            <TagInput value={p.workAuthorizedCountries} onChange={(v) => set("workAuthorizedCountries", v)} placeholder="United States" />
          </Field>
          <Toggle checked={p.requiresSponsorship} onChange={(v) => set("requiresSponsorship", v)} label={t("Tôi cần bảo lãnh visa", "I need visa sponsorship")} />
          <Toggle checked={p.willingToRelocate} onChange={(v) => set("willingToRelocate", v)} label={t("Sẵn sàng chuyển nơi ở", "Open to relocation")} />
          <div className="grid gap-3 sm:grid-cols-2">
            {text("earliestStart", t("Có thể bắt đầu", "Earliest start"), "Two weeks after offer")}
            {text("noticePeriod", t("Thời gian báo trước", "Notice period"), "2 weeks")}
            {text("salaryExpectation", t("Mức lương mong muốn (ghi trên form)", "Salary expectation (for forms)"), "$180,000")}
            {text("howDidYouHear", t("“Bạn biết đến chúng tôi qua đâu?”", "“How did you hear about us?”"), "Company website")}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-zinc-600">{t("Tự nguyện khai báo (EEO)", "Voluntary self-identification (EEO)")}</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <EeoSelect label={t("Giới tính", "Gender")} value={p.eeo.gender} onChange={(v) => set("eeo", { ...p.eeo, gender: v })} />
              <EeoSelect label={t("Chủng tộc", "Race")} value={p.eeo.race} onChange={(v) => set("eeo", { ...p.eeo, race: v })} />
              <EeoSelect label="Hispanic / Latino" value={p.eeo.hispanic} onChange={(v) => set("eeo", { ...p.eeo, hispanic: v })} />
              <EeoSelect label={t("Cựu chiến binh", "Veteran status")} value={p.eeo.veteran} onChange={(v) => set("eeo", { ...p.eeo, veteran: v })} />
              <EeoSelect label={t("Khuyết tật", "Disability status")} value={p.eeo.disability} onChange={(v) => set("eeo", { ...p.eeo, disability: v })} />
            </div>
          </details>
          <details className="text-sm" open={lib.length > 0}>
            <summary className="cursor-pointer text-zinc-600">{t(`Câu trả lời đã lưu (${lib.length})`, `Saved answers (${lib.length})`)}</summary>
            <div className="mt-3 space-y-3">
              {lib.map((a, i) => (
                <div key={i} className="rounded-lg border border-zinc-200 p-3">
                  <input className={cx(inputCls, "mb-2 font-medium")} value={a.question} onChange={(e) => setLib(lib.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))} />
                  <textarea className={cx(inputCls, "min-h-[60px]")} value={a.answer} onChange={(e) => setLib(lib.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))} />
                  <div className="mt-1 flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setLib(lib.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3 w-3" /> {t("Xoá", "Remove")}
                    </Button>
                  </div>
                </div>
              ))}
              <Button size="sm" onClick={() => setLib([...lib, { question: "", answer: "" }])}>
                <Plus className="h-3 w-3" /> {t("Thêm câu trả lời", "Add answer")}
              </Button>
            </div>
          </details>
        </div>
      </Card>

      <div className="sticky bottom-4 flex justify-end">
        <Button variant="primary" loading={saving === "all"} onClick={saveAll} className="shadow-lg">
          {t("Lưu thay đổi", "Save changes")}
        </Button>
      </div>
    </div>
  );
}

// ---------------- companies ----------------

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

function CompaniesTab() {
  const t = useT();
  const { data, error, reload } = useApi<{ sources: Source[] }>("/sources", { pollMs: 20_000 });
  const { save } = useSaver();
  const followed = new Set((data?.sources ?? []).map((s) => s.id));

  const toggle = async (id: string) => {
    if (followed.has(id)) await save(id, () => api(`/sources/${encodeURIComponent(id)}`, { method: "DELETE" }), t("Đã bỏ theo dõi", "Unfollowed"));
    else await save(id, () => api("/sources/catalog", { method: "POST", json: { ids: [id] } }), t("Đã theo dõi — đang quét việc làm", "Following — scanning jobs"));
    void reload(true);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t("Chọn công ty để theo dõi", "Choose companies to follow")} subtitle={t("Việc mới được kiểm tra mỗi 6 giờ.", "New jobs are checked every 6 hours.")} />
        <CompanyPicker selected={followed} onToggle={toggle} onAdded={() => void reload(true)} />
      </Card>
      {error && <ErrorNote message={error} />}
      <Card padded={false}>
        <div className="px-5 pt-5">
          <h3 className="text-sm font-semibold">{t(`Đang theo dõi (${data?.sources.length ?? 0})`, `Following (${data?.sources.length ?? 0})`)}</h3>
        </div>
        {!data ? (
          <Spinner />
        ) : data.sources.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500">{t("Chưa theo dõi công ty nào.", "Not following any companies yet.")}</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-100">
            {data.sources.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{s.company_name}</span>
                    {s.last_status && s.last_status !== "ok" && <Badge tone="red">{t("lỗi", "error")}</Badge>}
                  </div>
                  <div className="truncate text-xs text-zinc-500">
                    {t(`${s.job_count} việc đang mở · quét ${timeAgoT(t, s.last_crawled_at)}`, `${s.job_count} open jobs · scanned ${timeAgoT(t, s.last_crawled_at)}`)}
                    {s.last_error ? ` · ${s.last_error}` : ""}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => toggle(s.id)}>
                  {t("Bỏ theo dõi", "Unfollow")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------- automation & AI ----------------

interface UsageResponse {
  summary: UsageSummary;
  projectedUsd: number;
  byTask: { task: string; calls: number; input_tokens: number; output_tokens: number; cost: number }[];
}

function AutomationTab({ initial, onSaved }: { initial: UserSettings; onSaved: () => void }) {
  const t = useT();
  const [s, setS] = useState(initial);
  const { saving, save } = useSaver();
  const { me, reloadMe } = useMe();
  const { data: usage } = useApi<UsageResponse>("/usage");
  const set = <K extends keyof UserSettings>(k: K, v: UserSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const u = usage?.summary;
  const taskLabel: Record<string, string> = {
    jd_analysis: t("Phân tích tin tuyển dụng", "Job analysis"),
    match_reasoning: t("Xem lại điểm khó", "Ambiguous match review"),
    resume_tailor: t("Điều chỉnh resume", "Resume tailoring"),
    form_answers: t("Soạn câu trả lời", "Form answers"),
    resume_import: t("Nhập resume", "Resume import"),
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t("Tự động", "Automation")} subtitle={t("ApplyPilot tự tìm và chuẩn bị hồ sơ. Việc nộp luôn cần bạn duyệt.", "ApplyPilot finds and prepares applications. Submitting always needs your approval.")} />
        <div className="space-y-4">
          <Toggle
            checked={s.autoPrepare && s.autoShortlistScore > 0}
            onChange={(v) => setS((x) => ({ ...x, autoPrepare: v, autoShortlistScore: v ? x.autoShortlistScore || 75 : 0 }))}
            label={t("Tự chuẩn bị hồ sơ cho việc rất phù hợp", "Automatically prepare strong matches")}
            description={t("Mỗi ngày chuẩn bị vài hồ sơ tốt nhất để bạn chỉ cần duyệt.", "Prepares the best few each day so you only need to review.")}
          />
          {s.autoPrepare && s.autoShortlistScore > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t(`Từ ${s.autoShortlistScore} điểm trở lên`, `Score ${s.autoShortlistScore}+`)}>
                <input type="range" min={50} max={95} step={5} value={s.autoShortlistScore} onChange={(e) => set("autoShortlistScore", Number(e.target.value))} className="w-full accent-zinc-900" />
              </Field>
              <Field label={t("Tối đa mỗi ngày", "Per day, at most")}>
                <input type="number" min={1} max={20} className={cx(inputCls, "w-24")} value={s.autoPrepareDailyLimit} onChange={(e) => set("autoPrepareDailyLimit", Number(e.target.value))} />
              </Field>
            </div>
          )}
          <div>
            <Toggle checked={s.digestEnabled} onChange={(v) => set("digestEnabled", v)} label={t("Email tóm tắt mỗi sáng", "Morning email digest")} description={t("Việc mới phù hợp và hồ sơ chờ duyệt, gửi lúc 7:30 tới email đăng nhập của bạn.", "New matches and applications to review, sent at 7:30 to your sign-in email.")} />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <a href="/api/digest/preview" target="_blank" rel="noreferrer" className="font-medium text-zinc-600 underline hover:text-zinc-900">
                {t("Xem trước email hôm nay", "Preview today's email")}
              </a>
              {!me?.emailConfigured && <span className="text-amber-700">{t("Chưa cấu hình gửi email trên bản triển khai này (cần tên miền trong Cloudflare Email Service).", "Email sending isn't configured on this deployment yet (needs a domain in Cloudflare Email Service).")}</span>}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-200 p-4">
            <Toggle
              checked={s.liveSubmitEnabled}
              onChange={(v) => set("liveSubmitEnabled", v)}
              label={t("Cho phép nộp thật sau khi tôi duyệt", "Allow real submission after I approve")}
              description={t("Khi tắt, mọi lần duyệt chỉ chạy thử: form được điền và chụp màn hình nhưng không gửi.", "When off, approvals only dry-run: the form is filled and screenshotted but never sent.")}
            />
            {me?.submitMode !== "live" && (
              <p className="mt-3 flex gap-2 text-xs text-zinc-500">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                {t("Bản triển khai này đang ở chế độ chạy thử (SUBMIT_MODE=dry_run) nên chưa thể nộp thật.", "This deployment runs with SUBMIT_MODE=dry_run, so real submission stays off.")}
              </p>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("Ngân sách AI", "AI budget")} subtitle={t("Phần lớn công việc chạy bằng code thường. AI chỉ dùng khi thật sự có ích.", "Most work runs as plain code. AI is only used where it helps.")} />
        <div className="space-y-4">
          <Toggle checked={s.aiEnabled} onChange={(v) => set("aiEnabled", v)} label={t("Dùng Workers AI", "Use Workers AI")} description={t("Khi tắt hoặc hết ngân sách, mọi thứ vẫn chạy bằng cách khác.", "When off or out of budget, everything still works without it.")} />
          <Field label={t(`Ngân sách tháng: ${fmtMoney(s.monthlyBudgetUsd, 0)}`, `Monthly budget: ${fmtMoney(s.monthlyBudgetUsd, 0)}`)}>
            <input type="range" min={0} max={30} step={1} value={s.monthlyBudgetUsd} onChange={(e) => set("monthlyBudgetUsd", Number(e.target.value))} className="w-full accent-zinc-900" />
          </Field>
          {u && (
            <div className="rounded-lg bg-zinc-50 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xl font-semibold tabular-nums">{fmtMoney(u.spentUsd, 3)}</span>
                <span className="text-xs text-zinc-500">
                  {t(`Dự kiến ${fmtMoney(usage.projectedUsd, 2)} · ${u.calls} lượt · ${u.cacheHits} dùng lại cache`, `Projected ${fmtMoney(usage.projectedUsd, 2)} · ${u.calls} calls · ${u.cacheHits} cache hits`)}
                </span>
              </div>
              <div className="mt-2">
                <Progress value={u.budgetUsd ? (u.spentUsd / u.budgetUsd) * 100 : 0} />
              </div>
              {usage.byTask.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-zinc-600">
                  {usage.byTask.map((x) => (
                    <li key={x.task} className="flex justify-between">
                      <span>{taskLabel[x.task] ?? x.task}</span>
                      <span className="tabular-nums">
                        {x.calls} · {fmtMoney(x.cost, 4)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Card>
      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={saving === "s"}
          onClick={() =>
            save("s", () => api("/settings", { method: "PUT", json: s }), t("Đã lưu cài đặt", "Settings saved")).then(() => {
              reloadMe();
              onSaved();
            })
          }
        >
          {t("Lưu cài đặt", "Save settings")}
        </Button>
      </div>
    </div>
  );
}

// ---------------- data ----------------

function DataTab() {
  const t = useT();
  const [confirm, setConfirm] = useState("");
  const { saving, save } = useSaver();
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t("Dữ liệu của bạn được bảo vệ thế nào", "How your data is protected")} />
        <ul className="space-y-1.5 text-sm text-zinc-600">
          <li>· {t("Thông tin cá nhân, resume và câu trả lời được mã hoá AES-256 trong cơ sở dữ liệu.", "Personal details, resume and answers are AES-256 encrypted in the database.")}</li>
          <li>· {t("File resume, PDF và ảnh chụp được mã hoá trước khi lưu.", "Resume files, PDFs and screenshots are encrypted before storage.")}</li>
          <li>· {t("Chỉ bạn đăng nhập được (Cloudflare Access).", "Only you can sign in (Cloudflare Access).")}</li>
          <li>· {t("Không dùng dịch vụ AI hay cơ sở dữ liệu bên thứ ba.", "No third-party AI or database services.")}</li>
        </ul>
        <a href="/api/export" className="mt-4 inline-block">
          <Button>
            <Download className="h-3.5 w-3.5" /> {t("Tải bản sao dữ liệu (JSON)", "Download my data (JSON)")}
          </Button>
        </a>
      </Card>
      <Card className="border-red-200">
        <CardHeader title={t("Xoá tài khoản", "Delete account")} subtitle={t("Xoá vĩnh viễn hồ sơ, resume, đơn ứng tuyển và file. Không thể hoàn tác.", "Permanently deletes your profile, resumes, applications and files. Cannot be undone.")} />
        <div className="flex flex-wrap gap-2">
          <input className={cx(inputCls, "max-w-xs")} placeholder={t('Gõ "DELETE" để xác nhận', 'Type "DELETE" to confirm')} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button
            variant="danger"
            disabled={confirm !== "DELETE"}
            loading={saving === "del"}
            onClick={() => save("del", () => api("/account", { method: "DELETE", json: { confirm } }), t("Đã xoá tài khoản", "Account deleted")).then((ok) => ok && window.location.assign("/"))}
          >
            {t("Xoá tất cả", "Delete everything")}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function Me() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabId) || "resume";
  const { data, error, loading, reload } = useApi<ProfileResponse>("/profile");
  const onSaved = () => void reload(true);
  const tabs: { id: TabId; label: string }[] = [
    { id: "resume", label: "Resume" },
    { id: "profile", label: t("Thông tin & mong muốn", "Profile & preferences") },
    { id: "companies", label: t("Công ty", "Companies") },
    { id: "automation", label: t("Tự động & AI", "Automation & AI") },
    { id: "monitoring", label: t("Giám sát", "Monitoring") },
    { id: "data", label: t("Dữ liệu", "Data") },
  ];
  return (
    <div>
      <PageHeader title={t("Tôi", "Me")} description={t("Resume, mong muốn, công ty theo dõi và cài đặt.", "Your resume, preferences, companies and settings.")} />
      <Tabs tabs={tabs} value={tab} onChange={(id) => setParams({ tab: id })} />
      {error && <ErrorNote message={error} />}
      {tab === "resume" && <ResumeEditor />}
      {tab === "companies" && <CompaniesTab />}
      {tab === "data" && <DataTab />}
      {tab === "monitoring" && <Monitoring />}
      {(tab === "profile" || tab === "automation") &&
        (loading || !data ? (
          <Spinner />
        ) : tab === "profile" ? (
          <ProfileTab data={data} onSaved={onSaved} />
        ) : (
          <AutomationTab initial={data.settings} onSaved={onSaved} />
        ))}
    </div>
  );
}

