import { Compass, ExternalLink, RefreshCw, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AppStatus, JobAnalysis, MatchReasons } from "../../shared/types";
import { api, fmtSalary, timeAgo, useApi } from "../api";
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
  source_id: string;
  app_id: string | null;
  app_status: AppStatus | null;
}

interface JobDetail extends JobItem {
  id: string;
  description: string;
  apply_url: string;
  employment_type: string | null;
  department: string | null;
  analysis: JobAnalysis | null;
  analysis_method: string | null;
}

const BREAKDOWN_MAX = { skills: 45, title: 25, seniority: 10, location: 10, salary: 10 };

function JobDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { data: job, error, reload } = useApi<JobDetail>(id ? `/jobs/${id}` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);
  const toast = useToast();

  const act = async (kind: "shortlist" | "dismiss" | "prepare") => {
    if (!job) return;
    setBusy(kind);
    try {
      if (kind === "dismiss") {
        await api(`/jobs/${job.id}/dismiss`, { method: "POST" });
        toast("Job dismissed");
        onChanged();
        onClose();
        return;
      }
      const res = await api<{ id: string; duplicate?: boolean }>(`/jobs/${job.id}/shortlist`, { method: "POST" });
      if (kind === "prepare" && res.id) {
        await api(`/applications/${res.id}/prepare`, { method: "POST" });
        toast("Preparing application — tailoring resume and drafting answers");
      } else toast(res.duplicate ? "Already in your applications" : "Added to your queue");
      onChanged();
      void reload(true);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const r = job?.reasons;
  const salary = job && fmtSalary(job.salary_min, job.salary_max, job.salary_currency, job.salary_period);
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      title={job?.title ?? "Loading…"}
      subtitle={job && [job.company, job.location, job.workplace].filter(Boolean).join(" · ")}
      footer={
        job && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a href={job.job_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-zinc-600 hover:text-zinc-900">
              View posting <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <div className="flex gap-2">
              {!job.app_status && (
                <Button variant="ghost" onClick={() => act("dismiss")} loading={busy === "dismiss"}>
                  Dismiss
                </Button>
              )}
              {job.app_status ? (
                <Link to="/queue">
                  <Button>Open in queue</Button>
                </Link>
              ) : (
                <>
                  <Button onClick={() => act("shortlist")} loading={busy === "shortlist"}>
                    Shortlist
                  </Button>
                  <Button variant="primary" onClick={() => act("prepare")} loading={busy === "prepare"}>
                    <Sparkles className="h-3.5 w-3.5" /> Prepare application
                  </Button>
                </>
              )}
            </div>
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
            {salary && <Badge tone="green">{salary}</Badge>}
            {job.seniority && <Badge>{job.seniority}</Badge>}
            {job.employment_type && <Badge>{job.employment_type}</Badge>}
            <Badge tone={job.analysis_method === "ai" ? "violet" : "zinc"}>{job.analysis_method === "ai" ? "AI-analyzed" : "Heuristic analysis"}</Badge>
            <span className="text-xs text-zinc-400">First seen {timeAgo(job.first_seen_at)}</span>
          </div>

          {r && (
            <section>
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Why this score</h4>
              <div className="grid grid-cols-5 gap-2">
                {(Object.keys(BREAKDOWN_MAX) as (keyof typeof BREAKDOWN_MAX)[]).map((k) => (
                  <div key={k} className="rounded-lg bg-zinc-50 px-2.5 py-2">
                    <div className="text-[11px] capitalize text-zinc-500">{k}</div>
                    <div className="text-sm font-semibold tabular-nums">
                      {r.breakdown[k]}
                      <span className="font-normal text-zinc-400">/{BREAKDOWN_MAX[k]}</span>
                    </div>
                  </div>
                ))}
              </div>
              {job.ai_score != null && (
                <p className="mt-3 text-xs text-zinc-500">
                  Deterministic {job.det_score} · AI review {job.ai_score} → blended {job.score}
                </p>
              )}
              {r.rationale && <p className="mt-3 rounded-lg border border-violet-100 bg-violet-50/50 px-3 py-2 text-sm text-zinc-700">{r.rationale}</p>}
              <div className="mt-4 space-y-3">
                {r.matchedSkills.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs text-zinc-500">You have</div>
                    <div className="flex flex-wrap gap-1.5">
                      {r.matchedSkills.map((s) => (
                        <Badge key={s} tone="green">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {r.missingSkills.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs text-zinc-500">Not found in your resume</div>
                    <div className="flex flex-wrap gap-1.5">
                      {r.missingSkills.map((s) => (
                        <Badge key={s}>{s}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {[...r.flags, ...(r.concerns ?? [])].length > 0 && (
                  <ul className="space-y-1 text-sm text-amber-800">
                    {[...r.flags, ...(r.concerns ?? [])].map((f) => (
                      <li key={f}>· {f}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {job.analysis?.summary && (
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Role summary</h4>
              <p className="text-sm text-zinc-700">{job.analysis.summary}</p>
            </section>
          )}

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Job description</h4>
            <div className={cx("whitespace-pre-line text-sm leading-relaxed text-zinc-700", !showFull && "line-clamp-[18]")}>{job.description}</div>
            <button className="mt-2 text-xs font-medium text-zinc-500 hover:text-zinc-900" onClick={() => setShowFull((v) => !v)}>
              {showFull ? "Show less" : "Show full description"}
            </button>
          </section>
        </div>
      )}
    </Drawer>
  );
}

export default function Discovery() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [workplace, setWorkplace] = useState("");
  const [sort, setSort] = useState("score");
  const [hideApplied, setHideApplied] = useState(true);
  const [offset, setOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setOffset(0), [debounced, minScore, workplace, sort, hideApplied]);

  const path = useMemo(() => {
    const p = new URLSearchParams({ minScore: String(minScore), sort, offset: String(offset) });
    if (debounced) p.set("q", debounced);
    if (workplace) p.set("workplace", workplace);
    if (hideApplied) p.set("hideApplied", "1");
    return `/jobs?${p}`;
  }, [debounced, minScore, workplace, sort, hideApplied, offset]);
  const { data, error, loading, reload } = useApi<{ items: JobItem[]; hasMore: boolean }>(path);
  const selected = params.get("job");

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api<{ crawls: number }>("/discovery/refresh", { method: "POST" });
      toast(r.crawls ? `Crawling ${r.crawls} board(s). New matches appear in about a minute.` : "Boards are fresh — re-running matching now.");
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
        title="Job Discovery"
        description="Jobs from the boards you follow, filtered and scored against your resume and preferences."
        actions={
          <Button onClick={refresh} loading={refreshing}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh boards
          </Button>
        }
      />

      <Card className="mb-4" padded={false}>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input className={cx(inputCls, "pl-9")} placeholder="Search title, company or location" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className={selectInlineCls} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}>
            <option value={0}>Any score</option>
            <option value={50}>Score 50+</option>
            <option value={65}>Score 65+</option>
            <option value={80}>Score 80+</option>
          </select>
          <select className={selectInlineCls} value={workplace} onChange={(e) => setWorkplace(e.target.value)}>
            <option value="">Any workplace</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">On-site</option>
          </select>
          <select className={selectInlineCls} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="score">Best match</option>
            <option value="recent">Newest</option>
          </select>
          <label className="flex items-center gap-2 px-2 text-sm text-zinc-600">
            <input type="checkbox" checked={hideApplied} onChange={(e) => setHideApplied(e.target.checked)} className="rounded border-zinc-300" />
            Hide queued
          </label>
        </div>
      </Card>

      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : data && data.items.length === 0 ? (
        <Empty
          icon={<Compass className="h-7 w-7" />}
          title="No matching jobs"
          action={
            <Link to="/settings#sources">
              <Button>Manage job boards</Button>
            </Link>
          }
        >
          Matches appear here after your boards are crawled and scored. Try lowering the score filter, following more boards, or broadening your preferences.
        </Empty>
      ) : (
        data && (
          <Card padded={false}>
            <ul className="divide-y divide-zinc-100">
              {data.items.map((j) => {
                const salary = fmtSalary(j.salary_min, j.salary_max, j.salary_currency, j.salary_period);
                return (
                  <li key={j.job_id}>
                    <button onClick={() => setParams({ job: j.job_id })} className="flex w-full items-center gap-4 px-4 py-3.5 text-left transition hover:bg-zinc-50/80">
                      <ScoreBadge score={j.score} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-zinc-900">{j.title}</span>
                          {j.app_status && <StatusBadge status={j.app_status} />}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-zinc-500">
                          {j.company}
                          {j.location ? ` · ${j.location}` : ""}
                          {j.workplace ? ` · ${j.workplace}` : ""}
                        </div>
                        {j.reasons && j.reasons.matchedSkills.length > 0 && (
                          <div className="mt-1.5 hidden flex-wrap gap-1 sm:flex">
                            {j.reasons.matchedSkills.slice(0, 5).map((s) => (
                              <span key={s} className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">
                                {s}
                              </span>
                            ))}
                            {j.reasons.missingSkills.slice(0, 3).map((s) => (
                              <span key={s} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">
                                {s}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="hidden shrink-0 text-right sm:block">
                        {salary && <div className="text-sm font-medium tabular-nums text-zinc-800">{salary}</div>}
                        <div className="text-xs text-zinc-400">{timeAgo(j.posted_at ?? j.first_seen_at)}</div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            {(offset > 0 || data.hasMore) && (
              <div className="flex justify-between border-t border-zinc-100 px-4 py-3">
                <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
                  Previous
                </Button>
                <Button size="sm" disabled={!data.hasMore} onClick={() => setOffset(offset + 50)}>
                  Next
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
