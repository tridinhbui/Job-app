import { Briefcase, ExternalLink, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { AppStatus, JobAnalysis, MatchReasons, SkipReason } from "../../shared/types";
import { api, useApi } from "../api";
import { scoreSummary } from "../format";
import { timeAgoT, useT } from "../i18n";
import { Badge, Button, Card, cx, Drawer, Empty, ErrorNote, inputCls, PageHeader, ScoreBadge, selectInlineCls, Spinner, StatusBadge, useToast } from "../ui";

interface JobItem {
  job_id: string;
  score: number;
  det_score: number;
  ai_score: number | null;
  reasons: MatchReasons | null;
  title: string;
  company: string;
  location: string | null;
  workplace: string | null;
  seniority: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  posted_at: number | null;
  first_seen_at: number;
  job_url: string;
  app_id: string | null;
  app_status: AppStatus | null;
}

interface JobDetail extends JobItem {
  id: string;
  description: string;
  employment_type: string | null;
  analysis: JobAnalysis | null;
  analysis_method: string | null;
}

function useJobActions(onChanged: () => void) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const prepare = async (jobId: string) => {
    setBusy(jobId);
    try {
      const r = await api<{ id: string }>(`/jobs/${jobId}/prepare`, { method: "POST" });
      toast(t("Đang chuẩn bị hồ sơ — xem trong “Hồ sơ ứng tuyển”", "Preparing — see it under “Applications”"));
      onChanged();
      return r.id;
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };
  const skip = async (jobId: string, reason: SkipReason) => {
    setBusy(jobId);
    try {
      await api(`/jobs/${jobId}/dismiss`, { method: "POST", json: { reason } });
      const learned: Record<SkipReason, string> = {
        company: t("Sẽ ẩn mọi việc của công ty này", "Hiding all jobs from this company"),
        role: t("Sẽ ít gợi ý vai trò tương tự", "Showing fewer similar roles"),
        location: t("Sẽ ẩn việc ở địa điểm này", "Hiding jobs in this location"),
        salary: t("Đã bỏ qua", "Skipped"),
        other: t("Đã bỏ qua", "Skipped"),
      };
      toast(learned[reason]);
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };
  return { busy, prepare, skip, navigate };
}

function SkipMenu({ onSkip, disabled }: { onSkip: (r: SkipReason) => void; disabled?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const reasons: [SkipReason, string][] = [
    ["role", t("Không hợp vai trò", "Not the right role")],
    ["company", t("Không thích công ty", "Not this company")],
    ["location", t("Địa điểm không hợp", "Wrong location")],
    ["salary", t("Lương thấp", "Pay too low")],
    ["other", t("Lý do khác", "Other")],
  ];
  return (
    <div className="relative">
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpen((v) => !v)} aria-label={t("Bỏ qua", "Skip")}>
        <X className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{t("Bỏ qua", "Skip")}</span>
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-30 mt-1 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg">
            {reasons.map(([r, label]) => (
              <button
                key={r}
                className="block w-full rounded-md px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
                onClick={() => {
                  setOpen(false);
                  onSkip(r);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const BREAKDOWN_MAX: Record<string, number> = { skills: 30, semantic: 15, title: 15, experience: 10, seniority: 10, location: 10, salary: 10 };

function JobDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const { data: job, error, reload } = useApi<JobDetail>(id ? `/jobs/${id}` : null);
  const [showFull, setShowFull] = useState(false);
  const actions = useJobActions(() => {
    onChanged();
    void reload(true);
  });
  const r = job?.reasons;
  const labels: Record<string, string> = {
    skills: t("Kỹ năng", "Skills"),
    semantic: t("Độ tương đồng", "Similarity"),
    title: t("Chức danh", "Title"),
    experience: t("Kinh nghiệm", "Experience"),
    seniority: t("Cấp bậc", "Level"),
    location: t("Địa điểm", "Location"),
    salary: t("Lương", "Salary"),
  };
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      title={job?.title ?? t("Đang tải…", "Loading…")}
      subtitle={job && [job.company, job.location].filter(Boolean).join(" · ")}
      footer={
        job && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a href={job.job_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-zinc-600 hover:text-zinc-900">
              {t("Xem tin gốc", "View posting")} <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {job.app_id ? (
              <Link to={`/review/${job.app_id}`}>
                <Button variant="primary">{t("Mở hồ sơ", "Open application")}</Button>
              </Link>
            ) : (
              <div className="flex gap-2">
                <SkipMenu
                  disabled={actions.busy === job.id}
                  onSkip={(reason) => {
                    void actions.skip(job.id, reason);
                    onClose();
                  }}
                />
                <Button variant="primary" onClick={() => actions.prepare(job.id)} loading={actions.busy === job.id}>
                  <Sparkles className="h-3.5 w-3.5" /> {t("Chuẩn bị hồ sơ", "Prepare application")}
                </Button>
              </div>
            )}
          </div>
        )
      }
    >
      {error && <ErrorNote message={error} />}
      {!job && !error && <Spinner />}
      {job && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            {job.score != null && <ScoreBadge score={job.score} />}
            {job.app_status && <StatusBadge status={job.app_status} />}
            <span className="text-sm text-zinc-600">{scoreSummary(t, job.reasons, job)}</span>
          </div>
          {job.analysis?.summary && <p className="text-sm text-zinc-700">{job.analysis.summary}</p>}
          {r && (
            <section className="space-y-3">
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                {Object.keys(BREAKDOWN_MAX)
                  .filter((k) => typeof (r.breakdown as unknown as Record<string, number | null | undefined>)[k] === "number")
                  .map((k) => (
                    <div key={k} className="rounded-lg bg-zinc-50 px-2 py-2">
                      <div className="truncate text-[11px] text-zinc-500">{labels[k]}</div>
                      <div className="text-sm font-semibold tabular-nums">
                        {(r.breakdown as unknown as Record<string, number>)[k]}
                        <span className="font-normal text-zinc-400">/{BREAKDOWN_MAX[k]}</span>
                      </div>
                    </div>
                  ))}
              </div>
              {r.rationale && <p className="rounded-lg border border-violet-100 bg-violet-50/50 px-3 py-2 text-sm text-zinc-700">{r.rationale}</p>}
              {r.matchedSkills.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {r.matchedSkills.map((s) => (
                    <Badge key={s} tone="green">
                      {s}
                    </Badge>
                  ))}
                  {r.missingSkills.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              )}
              {[...r.flags, ...(r.concerns ?? [])].length > 0 && (
                <ul className="space-y-1 text-sm text-amber-800">
                  {[...r.flags, ...(r.concerns ?? [])].map((f) => (
                    <li key={f}>· {f}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("Mô tả công việc", "Job description")}</h4>
            <div className={cx("whitespace-pre-line text-sm leading-relaxed text-zinc-700", !showFull && "line-clamp-[16]")}>{job.description}</div>
            <button className="mt-2 text-xs font-medium text-zinc-500 hover:text-zinc-900" onClick={() => setShowFull((v) => !v)}>
              {showFull ? t("Thu gọn", "Show less") : t("Xem đầy đủ", "Show all")}
            </button>
          </section>
        </div>
      )}
    </Drawer>
  );
}

export default function Jobs() {
  const t = useT();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [minScore, setMinScore] = useState(50);
  const [workplace, setWorkplace] = useState("");
  const [sort, setSort] = useState("score");
  const [offset, setOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => setOffset(0), [debounced, minScore, workplace, sort]);

  const path = useMemo(() => {
    const p = new URLSearchParams({ minScore: String(minScore), sort, offset: String(offset), hideApplied: "1" });
    if (debounced) p.set("q", debounced);
    if (workplace) p.set("workplace", workplace);
    return `/jobs?${p}`;
  }, [debounced, minScore, workplace, sort, offset]);
  const { data, error, loading, reload } = useApi<{ items: JobItem[]; hasMore: boolean }>(path);
  const actions = useJobActions(() => void reload(true));
  const selected = params.get("job");

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api<{ crawls: number }>("/discovery/refresh", { method: "POST" });
      toast(r.crawls ? t(`Đang quét lại ${r.crawls} công ty…`, `Re-scanning ${r.crawls} companies…`) : t("Dữ liệu vẫn mới — đang chấm điểm lại.", "Data is fresh — re-scoring now."));
      setTimeout(() => void reload(true), 60_000);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={t("Việc làm", "Jobs")}
        description={t("Việc làm phù hợp với bạn, sắp xếp theo mức độ phù hợp.", "Jobs that fit you, best matches first.")}
        actions={
          <Button onClick={refresh} loading={refreshing}>
            <RefreshCw className="h-3.5 w-3.5" /> {t("Làm mới", "Refresh")}
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input className={cx(inputCls, "pl-9")} placeholder={t("Tìm chức danh, công ty, địa điểm", "Search title, company, location")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className={selectInlineCls} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}>
          <option value={0}>{t("Mọi mức", "Any score")}</option>
          <option value={50}>{t("Phù hợp (50+)", "Good fit (50+)")}</option>
          <option value={70}>{t("Rất phù hợp (70+)", "Strong fit (70+)")}</option>
        </select>
        <select className={selectInlineCls} value={workplace} onChange={(e) => setWorkplace(e.target.value)}>
          <option value="">{t("Mọi hình thức", "Any workplace")}</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">{t("Tại văn phòng", "On-site")}</option>
        </select>
        <select className={selectInlineCls} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="score">{t("Phù hợp nhất", "Best match")}</option>
          <option value="recent">{t("Mới nhất", "Newest")}</option>
        </select>
      </div>

      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : data && data.items.length === 0 ? (
        <Empty
          icon={<Briefcase className="h-7 w-7" />}
          title={t("Chưa có việc phù hợp", "No matching jobs yet")}
          action={
            <Link to="/me?tab=companies">
              <Button>{t("Theo dõi thêm công ty", "Follow more companies")}</Button>
            </Link>
          }
        >
          {t("Hạ mức điểm, theo dõi thêm công ty, hoặc mở rộng mong muốn của bạn.", "Lower the score filter, follow more companies, or broaden your preferences.")}
        </Empty>
      ) : (
        data && (
          <Card padded={false}>
            <ul className="divide-y divide-zinc-100">
              {data.items.map((j) => (
                <li key={j.job_id} className="flex items-center gap-3 px-4 py-3">
                  <ScoreBadge score={j.score} />
                  <button onClick={() => setParams({ job: j.job_id })} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-zinc-900">{j.title}</span>
                      {j.app_status && <StatusBadge status={j.app_status} />}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500">
                      {j.company}
                      {j.location ? ` · ${j.location}` : ""}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-600">
                      {scoreSummary(t, j.reasons, j)}
                      <span className="text-zinc-400"> · {timeAgoT(t, j.posted_at ?? j.first_seen_at)}</span>
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <SkipMenu disabled={actions.busy === j.job_id} onSkip={(r) => actions.skip(j.job_id, r)} />
                    <Button size="sm" onClick={() => actions.prepare(j.job_id)} loading={actions.busy === j.job_id}>
                      <Sparkles className="h-3 w-3" /> <span className="hidden sm:inline">{t("Chuẩn bị", "Prepare")}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {(offset > 0 || data.hasMore) && (
              <div className="flex justify-between border-t border-zinc-100 px-4 py-3">
                <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
                  {t("Trước", "Previous")}
                </Button>
                <Button size="sm" disabled={!data.hasMore} onClick={() => setOffset(offset + 50)}>
                  {t("Tiếp", "Next")}
                </Button>
              </div>
            )}
          </Card>
        )
      )}

      <JobDrawer
        id={selected}
        onClose={() => {
          params.delete("job");
          setParams(params);
        }}
        onChanged={() => void reload(true)}
      />
    </div>
  );
}
