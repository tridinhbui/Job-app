import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { AppStatus, MatchReasons, UsageSummary } from "../../shared/types";
import { api, fmtMoney, useApi } from "../api";
import { scoreSummary } from "../format";
import { useT } from "../i18n";
import { Button, Card, CardHeader, cx, Empty, ErrorNote, PageHeader, Progress, ScoreBadge, Spinner, StatusBadge, useStatusLabel, useToast } from "../ui";

interface TodayData {
  todo: { id: string; status: AppStatus; error: string | null; missing: string[]; title: string; company: string; score: number | null }[];
  fresh: {
    job_id: string;
    score: number;
    reasons: MatchReasons | null;
    title: string;
    company: string;
    location: string | null;
    workplace: string | null;
    salary_min: number | null;
    salary_max: number | null;
    salary_currency: string | null;
    salary_period: string | null;
  }[];
  statusCounts: Partial<Record<AppStatus, number>>;
  totalMatches: number;
  sources: { total: number; crawled: number };
  incidents: { kind: string; message: string; ref?: string }[];
  usage: UsageSummary;
}

interface Progress {
  sources: number;
  crawled: number;
  jobs: number;
  matches: number;
  matching: boolean;
}

/** Shown while the first crawl + match is still running after onboarding. */
function SetupProgress({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [finished, setFinished] = useState(false);
  const { data } = useApi<Progress>("/onboarding/progress", { pollMs: finished ? 0 : 3000 });
  const done = !!data && data.sources > 0 && data.crawled >= data.sources && !data.matching;
  useEffect(() => {
    if (done && !finished) {
      setFinished(true);
      onDone();
    }
  }, [done, finished, onDone]);
  if (!data || done || data.sources === 0) return null;
  return (
    <Card className="border-sky-200 bg-sky-50/40">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-sky-600" />
        <div className="text-sm text-zinc-700">
          <div className="font-medium text-zinc-900">{t("Đang tìm việc cho bạn…", "Finding jobs for you…")}</div>
          {t(
            `Đã quét ${data.crawled}/${data.sources} công ty · ${data.jobs} việc làm · ${data.matches} phù hợp`,
            `Scanned ${data.crawled}/${data.sources} companies · ${data.jobs} jobs · ${data.matches} matches`,
          )}
        </div>
      </div>
    </Card>
  );
}

export default function Today() {
  const t = useT();
  const statusLabel = useStatusLabel();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<TodayData>("/today", { pollMs: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const onSetupDone = useCallback(() => void reload(true), [reload]);

  if (error) return <ErrorNote message={error} />;
  if (loading || !data) return <Spinner />;

  const c = data.statusCounts;
  const n = (s: AppStatus) => c[s] ?? 0;
  const waiting = data.todo.filter((x) => x.status === "prepared");
  const attention = data.todo.filter((x) => x.status === "needs_manual" || x.status === "failed");
  const working = data.todo.filter((x) => ["preparing", "approved", "submitting"].includes(x.status));
  const applied = n("submitted") + n("interview") + n("offered") + n("rejected");

  const prepare = async (jobId: string) => {
    setBusy(jobId);
    try {
      await api(`/jobs/${jobId}/prepare`, { method: "POST" });
      toast(t("Đang chuẩn bị hồ sơ — sẽ có trong mục chờ duyệt sau khoảng 1 phút", "Preparing — it will be ready for review in about a minute"));
      void reload(true);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const hello = new Date().getHours() < 12 ? t("Chào buổi sáng", "Good morning") : new Date().getHours() < 18 ? t("Chào buổi chiều", "Good afternoon") : t("Chào buổi tối", "Good evening");
  const summary =
    waiting.length + attention.length > 0
      ? t(`Bạn có ${waiting.length + attention.length} việc cần làm.`, `You have ${waiting.length + attention.length} thing(s) to do.`)
      : t("Không có gì cần làm ngay — ApplyPilot đang tìm việc cho bạn.", "Nothing needs you right now — ApplyPilot keeps looking.");

  return (
    <div className="space-y-6">
      <PageHeader title={hello} description={summary} />

      <SetupProgress onDone={onSetupDone} />

      {data.incidents.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/40">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium text-zinc-900">{t("Có vấn đề cần chú ý", "Some things need attention")}</div>
              <ul className="mt-1 space-y-0.5 text-zinc-700">
                {data.incidents.slice(0, 5).map((i, k) => (
                  <li key={k} className="truncate">
                    · {i.message}
                  </li>
                ))}
              </ul>
              {data.incidents.some((i) => i.kind === "source") && (
                <Link to="/me?tab=companies" className="mt-2 inline-block text-xs font-medium text-amber-800 underline">
                  {t("Xem công ty theo dõi", "Review followed companies")}
                </Link>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* 1. What needs you */}
      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{t("Việc cần bạn làm", "Needs you")}</h3>
            <p className="text-xs text-zinc-500">{t("Duyệt hồ sơ đã chuẩn bị sẵn. Không có gì được nộp khi chưa có bạn đồng ý.", "Review prepared applications. Nothing is submitted without your approval.")}</p>
          </div>
          {waiting.length > 0 && (
            <Button variant="primary" className="shrink-0 whitespace-nowrap" onClick={() => navigate(`/review/${waiting[0]!.id}`)}>
              {t("Bắt đầu duyệt", "Start reviewing")} <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        {waiting.length + attention.length + working.length === 0 ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-zinc-500">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" /> {t("Bạn đã xử lý xong tất cả.", "You're all caught up.")}
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-100">
            {[...waiting, ...attention, ...working].map((a) => (
              <li key={a.id}>
                <Link to={`/review/${a.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-zinc-50">
                  {a.score != null ? <ScoreBadge score={a.score} /> : <span className="w-10" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{a.title}</div>
                    <div className="truncate text-xs text-zinc-500">
                      {a.company}
                      {a.missing.length > 0 && a.status === "prepared" && <span className="text-amber-700"> · {t(`${a.missing.length} câu cần bạn trả lời`, `${a.missing.length} question(s) need you`)}</span>}
                    </div>
                  </div>
                  <span className="hidden sm:inline-flex">
                    <StatusBadge status={a.status} />
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-zinc-300" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 2. New matches */}
      <Card padded={false}>
        <div className="flex items-center justify-between px-5 pt-5">
          <div>
            <h3 className="text-sm font-semibold">{t("Việc làm mới phù hợp", "New matches")}</h3>
            <p className="text-xs text-zinc-500">{t("Bấm “Chuẩn bị” để ApplyPilot viết hồ sơ riêng cho từng việc.", "Click “Prepare” and ApplyPilot tailors an application for that job.")}</p>
          </div>
          <Link to="/jobs" className="text-xs font-medium text-zinc-500 hover:text-zinc-900">
            {t(`Tất cả ${data.totalMatches} việc →`, `All ${data.totalMatches} jobs →`)}
          </Link>
        </div>
        {data.fresh.length === 0 ? (
          <div className="px-5 py-6">
            <Empty title={t("Chưa có việc mới trong 3 ngày qua", "No new matches in the last 3 days")}>
              {t("Thêm công ty để có nhiều lựa chọn hơn.", "Follow more companies to see more options.")}
            </Empty>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-100">
            {data.fresh.map((j) => (
              <li key={j.job_id} className="flex items-center gap-3 px-5 py-3">
                <ScoreBadge score={j.score} />
                <Link to={`/jobs?job=${j.job_id}`} className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{j.title}</div>
                  <div className="truncate text-xs text-zinc-500">
                    {j.company} · {scoreSummary(t, j.reasons, j) || j.location}
                  </div>
                </Link>
                <Button size="sm" onClick={() => prepare(j.job_id)} loading={busy === j.job_id}>
                  <Sparkles className="h-3 w-3" /> {t("Chuẩn bị", "Prepare")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 3. Progress */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader title={t("Tiến độ", "Progress")} />
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              [t("Đã nộp", "Applied"), applied],
              [statusLabel("interview"), n("interview")],
              [statusLabel("offered"), n("offered")],
            ].map(([label, v]) => (
              <div key={label as string}>
                <div className="text-xl font-semibold tabular-nums">{v}</div>
                <div className="text-[11px] text-zinc-500">{label}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Nguồn việc làm", "Job sources")} />
          <div className="text-xl font-semibold tabular-nums">{data.sources.total}</div>
          <div className="text-xs text-zinc-500">
            {t("công ty đang theo dõi", "companies followed")} ·{" "}
            <Link className="underline" to="/me?tab=companies">
              {t("thêm", "add more")}
            </Link>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Chi phí AI tháng này", "AI cost this month")} />
          <div className="text-xl font-semibold tabular-nums">{fmtMoney(data.usage.spentUsd, 2)}</div>
          <div className={cx("mt-2")}>
            <Progress value={data.usage.budgetUsd ? (data.usage.spentUsd / data.usage.budgetUsd) * 100 : 0} />
          </div>
          <div className="mt-1 text-xs text-zinc-500">{t(`trên ngân sách ${fmtMoney(data.usage.budgetUsd, 0)}`, `of ${fmtMoney(data.usage.budgetUsd, 0)} budget`)}</div>
        </Card>
      </div>
    </div>
  );
}
