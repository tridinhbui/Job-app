import { Inbox, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { AppStatus } from "../../shared/types";
import { api, timeAgo, useApi } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, ScoreBadge, Spinner, StatusBadge, useToast } from "../ui";
import { ApplicationDrawer } from "./ApplicationDrawer";

export interface AppItem {
  id: string;
  job_id: string;
  status: AppStatus;
  adapter: string | null;
  tailor_method: string | null;
  missing: string[];
  submit_mode: string | null;
  submitted_at: number | null;
  error: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  title: string;
  company: string;
  location: string | null;
  workplace: string | null;
  job_url: string;
  apply_url: string;
  job_status: string;
  score: number | null;
}

const GROUPS: { title: string; subtitle: string; statuses: AppStatus[] }[] = [
  { title: "Needs your review", subtitle: "Prepared applications wait here until you approve them.", statuses: ["prepared", "needs_manual", "failed"] },
  { title: "In progress", subtitle: "Being prepared or filled in the browser.", statuses: ["preparing", "approved", "submitting"] },
  { title: "Shortlisted", subtitle: "Prepare to tailor the resume and draft answers.", statuses: ["shortlisted"] },
];

export default function Queue() {
  const { data, error, loading, reload } = useApi<{ items: AppItem[] }>("/applications?status=shortlisted,preparing,prepared,approved,submitting,needs_manual,failed", { pollMs: 8000 });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const prepare = async (id: string) => {
    setBusy(id);
    try {
      await api(`/applications/${id}/prepare`, { method: "POST" });
      toast("Preparing — this usually takes under a minute");
      void reload(true);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const prepareAll = async () => {
    const targets = (data?.items ?? []).filter((a) => a.status === "shortlisted").slice(0, 10);
    for (const a of targets) await prepare(a.id);
  };

  return (
    <div>
      <PageHeader
        title="Application Queue"
        description="Review tailored resumes and answers. Nothing is submitted until you approve it."
        actions={
          (data?.items ?? []).some((a) => a.status === "shortlisted") && (
            <Button onClick={prepareAll}>
              <Sparkles className="h-3.5 w-3.5" /> Prepare shortlisted
            </Button>
          )
        }
      />
      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : data && data.items.length === 0 ? (
        <Empty
          icon={<Inbox className="h-7 w-7" />}
          title="Your queue is empty"
          action={
            <Link to="/discovery">
              <Button>Find jobs</Button>
            </Link>
          }
        >
          Shortlist jobs from Job Discovery. ApplyPilot then tailors your resume, reads the application form and drafts answers for your review.
        </Empty>
      ) : (
        <div className="space-y-6">
          {GROUPS.map((g) => {
            const items = (data?.items ?? []).filter((a) => g.statuses.includes(a.status));
            if (!items.length) return null;
            return (
              <section key={g.title}>
                <div className="mb-2 flex items-baseline gap-2">
                  <h2 className="text-sm font-semibold">{g.title}</h2>
                  <span className="text-xs text-zinc-400">{items.length}</span>
                  <span className="hidden text-xs text-zinc-400 sm:inline">· {g.subtitle}</span>
                </div>
                <Card padded={false}>
                  <ul className="divide-y divide-zinc-100">
                    {items.map((a) => (
                      <li key={a.id} className="flex items-center gap-4 px-4 py-3.5">
                        {a.score != null ? <ScoreBadge score={a.score} /> : <span className="h-8 w-10" />}
                        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(a.id)}>
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{a.title}</span>
                            <StatusBadge status={a.status} />
                            {a.job_status === "closed" && <Badge tone="red">Closed</Badge>}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-zinc-500">
                            {a.company}
                            {a.location ? ` · ${a.location}` : ""} · updated {timeAgo(a.updated_at)}
                          </div>
                          {a.missing.length > 0 && a.status !== "shortlisted" && (
                            <div className="mt-1 truncate text-xs text-amber-700">Needs input: {a.missing.join(", ")}</div>
                          )}
                          {a.status !== "prepared" && a.error && !a.missing.length && <div className="mt-1 truncate text-xs text-amber-700">{a.error}</div>}
                        </button>
                        <div className="flex shrink-0 gap-2">
                          {(a.status === "shortlisted" || a.status === "failed") && (
                            <Button size="sm" onClick={() => prepare(a.id)} loading={busy === a.id}>
                              {a.status === "failed" ? "Retry" : "Prepare"}
                            </Button>
                          )}
                          {["prepared", "needs_manual"].includes(a.status) && (
                            <Button size="sm" variant="primary" onClick={() => setOpen(a.id)}>
                              Review
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            );
          })}
        </div>
      )}
      <ApplicationDrawer id={open} onClose={() => setOpen(null)} onChanged={() => void reload(true)} />
    </div>
  );
}
