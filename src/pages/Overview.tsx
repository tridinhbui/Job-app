import { ArrowRight, CheckCircle2, Circle, Compass } from "lucide-react";
import { Link } from "react-router";
import type { AppStatus, UsageSummary } from "../../shared/types";
import { fmtMoney, timeAgo, useApi } from "../api";
import { Badge, Card, CardHeader, cx, Empty, ErrorNote, PageHeader, Progress, ScoreBadge, Spinner, Stat, statusLabel } from "../ui";

interface OverviewData {
  statusCounts: Partial<Record<AppStatus, number>>;
  matches: { total: number; week: number };
  events: { id: number; type: string; to_status: AppStatus | null; message: string | null; created_at: number; application_id: string; title: string; company: string }[];
  topMatches: { job_id: string; score: number; title: string; company: string; location: string | null; workplace: string | null }[];
  sources: { id: string; ats: string; company_name: string; last_crawled_at: number | null; last_status: string | null; last_error: string | null; job_count: number }[];
  usage: UsageSummary;
  daily: { day: string; cost: number; calls: number }[];
}

const PIPELINE: AppStatus[] = ["shortlisted", "prepared", "submitted", "interview", "offered", "rejected"];
const PIPE_COLORS: Record<string, string> = {
  shortlisted: "bg-zinc-300",
  prepared: "bg-violet-400",
  submitted: "bg-sky-500",
  interview: "bg-indigo-600",
  offered: "bg-emerald-500",
  rejected: "bg-zinc-200",
};

export default function Overview() {
  const { data, error, loading } = useApi<OverviewData>("/overview", { pollMs: 30_000 });
  const { data: resume } = useApi<{ resume: { skills: string[]; experience: unknown[] } }>("/resume");
  if (error) return <ErrorNote message={error} />;
  if (loading || !data) return <Spinner />;

  const c = data.statusCounts;
  const n = (s: AppStatus) => c[s] ?? 0;
  const submittedTotal = n("submitted") + n("interview") + n("offered") + n("rejected");
  const pipeTotal = PIPELINE.reduce((sum, s) => sum + n(s), 0) || 1;
  const needsAttention = n("prepared") + n("needs_manual") + n("failed");
  const hasResume = !!resume && (resume.resume.skills.length > 0 || resume.resume.experience.length > 0);
  const u = data.usage;
  const maxDaily = Math.max(0.0001, ...data.daily.map((d) => d.cost));

  const steps = [
    { done: hasResume, label: "Add your resume", to: "/resume" },
    { done: data.sources.length > 0, label: "Follow company job boards", to: "/settings#sources" },
    { done: data.matches.total > 0, label: "Review matched jobs", to: "/discovery" },
    { done: submittedTotal > 0, label: "Approve your first application", to: "/queue" },
  ];
  const onboarding = steps.some((s) => !s.done);

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="Your job search at a glance." />

      {onboarding && (
        <Card>
          <CardHeader title="Get set up" subtitle="ApplyPilot works from your own resume and the boards you follow. Nothing is submitted without your approval." />
          <div className="grid gap-2 sm:grid-cols-4">
            {steps.map((s) => (
              <Link key={s.label} to={s.to} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2.5 text-sm hover:bg-zinc-50">
                {s.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-zinc-300" />}
                <span className={cx(s.done && "text-zinc-400 line-through")}>{s.label}</span>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="New matches · 7 days" value={data.matches.week} sub={`${data.matches.total} open matches`} />
        <Stat label="Needs your attention" value={needsAttention} sub={`${n("prepared")} ready for review`} />
        <Stat label="Submitted" value={submittedTotal} sub={`${n("submitting") + n("approved")} in progress`} />
        <Stat label="Interviews & offers" value={n("interview") + n("offered")} sub={submittedTotal ? `${Math.round(((n("interview") + n("offered")) / submittedTotal) * 100)}% response rate` : "—"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Pipeline" subtitle="Applications by stage" action={<Link to="/tracker" className="text-xs font-medium text-zinc-500 hover:text-zinc-900">Open tracker →</Link>} />
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-100">
            {PIPELINE.map((s) => (n(s) ? <div key={s} className={PIPE_COLORS[s]} style={{ width: `${(n(s) / pipeTotal) * 100}%` }} title={`${statusLabel(s)}: ${n(s)}`} /> : null))}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
            {PIPELINE.map((s) => (
              <div key={s}>
                <div className="flex items-center gap-1.5 truncate text-xs text-zinc-500">
                  <span className={cx("h-2 w-2 shrink-0 rounded-full", PIPE_COLORS[s])} />
                  <span className="truncate">{s === "prepared" ? "Ready" : statusLabel(s)}</span>
                </div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{n(s)}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="AI spend" subtitle={`${u.month} · ${u.calls} calls · ${u.cacheHits} cache hits`} action={<Link to="/settings#usage" className="text-xs font-medium text-zinc-500 hover:text-zinc-900">Details →</Link>} />
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums">{fmtMoney(u.spentUsd, 3)}</span>
            <span className="text-sm text-zinc-500">of {fmtMoney(u.budgetUsd, 0)}</span>
          </div>
          <div className="mt-3">
            <Progress value={u.budgetUsd ? (u.spentUsd / u.budgetUsd) * 100 : 0} tone={u.mode === "exhausted" ? "red" : u.mode === "normal" ? "zinc" : "amber"} />
          </div>
          <div className="mt-4 flex h-14 items-end gap-[3px]">
            {data.daily.length === 0 ? (
              <span className="text-xs text-zinc-400">No AI calls in the last 30 days.</span>
            ) : (
              data.daily.map((d) => <div key={d.day} title={`${d.day}: ${fmtMoney(d.cost, 4)} (${d.calls} calls)`} className="flex-1 rounded-sm bg-zinc-800/80" style={{ height: `${Math.max(6, (d.cost / maxDaily) * 100)}%` }} />)
            )}
          </div>
          {u.blocked > 0 && <p className="mt-3 text-xs text-amber-700">{u.blocked} AI call(s) skipped by the budget guard; deterministic fallbacks were used.</p>}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Top unreviewed matches" action={<Link to="/discovery" className="text-xs font-medium text-zinc-500 hover:text-zinc-900">All jobs →</Link>} />
          {data.topMatches.length === 0 ? (
            <Empty icon={<Compass className="h-6 w-6" />} title="No matches yet">
              Follow a few job boards and add your resume — matching runs automatically.
            </Empty>
          ) : (
            <ul className="-mx-2 divide-y divide-zinc-100">
              {data.topMatches.map((m) => (
                <li key={m.job_id}>
                  <Link to={`/discovery?job=${m.job_id}`} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-zinc-50">
                    <ScoreBadge score={m.score} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{m.title}</div>
                      <div className="truncate text-xs text-zinc-500">
                        {m.company}
                        {m.location ? ` · ${m.location}` : ""}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-zinc-300" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          {data.events.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing yet.</p>
          ) : (
            <ul className="space-y-3">
              {data.events.map((e) => (
                <li key={e.id} className="flex gap-3 text-sm">
                  <span className={cx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", e.type === "error" ? "bg-red-500" : e.type === "status" ? "bg-zinc-800" : "bg-zinc-300")} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <span className="font-medium">{e.company}</span> <span className="text-zinc-500">· {e.title}</span>
                    </div>
                    <div className="line-clamp-2 text-xs text-zinc-500">
                      {e.to_status && <Badge className="mr-1.5">{statusLabel(e.to_status)}</Badge>}
                      {e.message}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-zinc-400">{timeAgo(e.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {data.sources.length > 0 && (
        <Card>
          <CardHeader title="Board health" subtitle="Boards are crawled every 6 hours; one crawl serves every user following the board." />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.sources.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg border border-zinc-100 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{s.company_name}</div>
                  <div className="text-xs text-zinc-500">
                    {s.ats} · {s.job_count} jobs · {timeAgo(s.last_crawled_at)}
                  </div>
                </div>
                <Badge tone={s.last_status === "ok" ? "green" : s.last_status ? "red" : "zinc"}>{s.last_status ?? "pending"}</Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
