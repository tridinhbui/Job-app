import { KanbanSquare, List } from "lucide-react";
import { useState } from "react";
import type { AppStatus } from "../../shared/types";
import { timeAgo, useApi } from "../api";
import { Card, cx, Empty, ErrorNote, PageHeader, Spinner, StatusBadge } from "../ui";
import { ApplicationDrawer } from "./ApplicationDrawer";
import type { AppItem } from "./Queue";

const COLUMNS: { title: string; statuses: AppStatus[]; accent: string }[] = [
  { title: "In queue", statuses: ["shortlisted", "preparing", "prepared", "approved", "submitting", "needs_manual", "failed"], accent: "bg-zinc-400" },
  { title: "Submitted", statuses: ["submitted"], accent: "bg-sky-500" },
  { title: "Interview", statuses: ["interview"], accent: "bg-indigo-600" },
  { title: "Offer", statuses: ["offered"], accent: "bg-emerald-500" },
  { title: "Closed", statuses: ["rejected", "withdrawn"], accent: "bg-zinc-200" },
];

export default function Tracker() {
  const { data, error, loading, reload } = useApi<{ items: AppItem[] }>("/applications", { pollMs: 30_000 });
  const [view, setView] = useState<"board" | "list">("board");
  const [open, setOpen] = useState<string | null>(null);
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Tracker"
        description="Every application from discovery to offer, with full history."
        actions={
          <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 shadow-sm">
            {(["board", "list"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={cx("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium", view === v ? "bg-zinc-900 text-white" : "text-zinc-600 hover:text-zinc-900")}>
                {v === "board" ? <KanbanSquare className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
                {v === "board" ? "Board" : "History"}
              </button>
            ))}
          </div>
        }
      />
      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty icon={<KanbanSquare className="h-7 w-7" />} title="No applications yet">
          Shortlist jobs in Job Discovery to start tracking them.
        </Empty>
      ) : view === "board" ? (
        <div className="grid gap-4 overflow-x-auto pb-2 md:grid-cols-5">
          {COLUMNS.map((col) => {
            const colItems = items.filter((a) => col.statuses.includes(a.status));
            return (
              <div key={col.title} className="min-w-[220px]">
                <div className="mb-2 flex items-center gap-2 px-1">
                  <span className={cx("h-2 w-2 rounded-full", col.accent)} />
                  <span className="text-xs font-semibold text-zinc-700">{col.title}</span>
                  <span className="text-xs text-zinc-400">{colItems.length}</span>
                </div>
                <div className="space-y-2">
                  {colItems.map((a) => (
                    <button key={a.id} onClick={() => setOpen(a.id)} className="block w-full rounded-lg border border-zinc-200/80 bg-white p-3 text-left shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition hover:border-zinc-300">
                      <div className="line-clamp-2 text-sm font-medium">{a.title}</div>
                      <div className="mt-0.5 truncate text-xs text-zinc-500">{a.company}</div>
                      <div className="mt-2 flex items-center justify-between">
                        <StatusBadge status={a.status} />
                        <span className="text-[11px] text-zinc-400">{timeAgo(a.submitted_at ?? a.updated_at)}</span>
                      </div>
                    </button>
                  ))}
                  {colItems.length === 0 && <div className="rounded-lg border border-dashed border-zinc-200 py-6 text-center text-xs text-zinc-400">Empty</div>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-xs text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Score</th>
                  <th className="px-4 py-2.5 font-medium">Submitted</th>
                  <th className="px-4 py-2.5 font-medium">Last update</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {items.map((a) => (
                  <tr key={a.id} className="cursor-pointer hover:bg-zinc-50" onClick={() => setOpen(a.id)}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{a.title}</div>
                      <div className="text-xs text-zinc-500">{a.company}</div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-600">{a.score ?? "—"}</td>
                    <td className="px-4 py-3 text-zinc-600">{a.submitted_at ? new Date(a.submitted_at).toLocaleDateString() : "—"}</td>
                    <td className="px-4 py-3 text-zinc-500">{timeAgo(a.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <ApplicationDrawer id={open} onClose={() => setOpen(null)} onChanged={() => void reload(true)} />
    </div>
  );
}
