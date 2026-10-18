import { FlaskConical, Inbox, Send } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { AppStatus } from "../../shared/types";
import { useMe } from "../App";
import { api, useApi } from "../api";
import { timeAgoT, useT } from "../i18n";
import { Badge, Button, Card, Empty, ErrorNote, Modal, PageHeader, ScoreBadge, Spinner, StatusBadge, Tabs, useToast } from "../ui";

export interface AppItem {
  id: string;
  job_id: string;
  status: AppStatus;
  adapter: string | null;
  missing: string[];
  submitted_at: number | null;
  error: string | null;
  updated_at: number;
  title: string;
  company: string;
  location: string | null;
  job_status: string;
  score: number | null;
}

type TabId = "review" | "working" | "applied" | "interview" | "closed";
const GROUPS: Record<TabId, AppStatus[]> = {
  review: ["prepared", "needs_manual", "failed", "shortlisted"],
  working: ["preparing", "approved", "submitting"],
  applied: ["submitted"],
  interview: ["interview", "offered"],
  closed: ["rejected", "withdrawn"],
};

export default function Applications() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { me } = useMe();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabId) || "review";
  const { data, error, loading, reload } = useApi<{ items: AppItem[] }>("/applications", { pollMs: 8000 });
  const [batchOpen, setBatchOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const items = data?.items ?? [];
  const count = (id: TabId) => items.filter((a) => GROUPS[id].includes(a.status)).length;
  const visible = items.filter((a) => GROUPS[tab].includes(a.status));
  const ready = items.filter((a) => a.status === "prepared" && a.missing.length === 0 && (a.adapter === "greenhouse" || a.adapter === "ashby"));
  const live = me?.submitMode === "live" && me.liveSubmitEnabled;

  const runBatch = async () => {
    setBusy(true);
    try {
      const r = await api<{ results: { id: string; ok: boolean; error?: string }[] }>("/applications/approve-batch", {
        method: "POST",
        json: { ids: ready.map((a) => a.id).slice(0, 25), mode: live ? "live" : "dry_run", confirm: true },
      });
      const ok = r.results.filter((x) => x.ok).length;
      const skipped = r.results.length - ok;
      toast(
        t(`Đã duyệt ${ok} hồ sơ${skipped ? `, ${skipped} cần bạn xem riêng` : ""}`, `Approved ${ok}${skipped ? `, ${skipped} need individual review` : ""}`),
      );
      setBatchOpen(false);
      void reload(true);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: "review", label: t("Chờ duyệt", "To review") },
    { id: "working", label: t("Đang xử lý", "In progress") },
    { id: "applied", label: t("Đã nộp", "Applied") },
    { id: "interview", label: t("Phỏng vấn", "Interviews") },
    { id: "closed", label: t("Đã đóng", "Closed") },
  ];

  return (
    <div>
      <PageHeader
        title={t("Hồ sơ ứng tuyển", "Applications")}
        description={t("Mọi hồ sơ từ lúc chuẩn bị đến khi có kết quả.", "Every application from preparation to outcome.")}
        actions={
          tab === "review" &&
          ready.length > 1 && (
            <Button onClick={() => setBatchOpen(true)}>
              {live ? <Send className="h-3.5 w-3.5" /> : <FlaskConical className="h-3.5 w-3.5" />}
              {live ? t(`Duyệt ${ready.length} hồ sơ đầy đủ`, `Approve ${ready.length} complete`) : t(`Chạy thử ${ready.length} hồ sơ`, `Dry-run ${ready.length}`)}
            </Button>
          )
        }
      />
      <Tabs
        tabs={tabs.map((x) => ({ id: x.id, label: (
          <>
            {x.label}
            {count(x.id) > 0 && <span className="rounded-full bg-zinc-100 px-1.5 text-[11px] text-zinc-600">{count(x.id)}</span>}
          </>
        ) }))}
        value={tab}
        onChange={(id) => setParams({ tab: id })}
      />

      {error && <ErrorNote message={error} />}
      {loading && !data ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <Empty
          icon={<Inbox className="h-7 w-7" />}
          title={tab === "review" ? t("Không có hồ sơ nào chờ duyệt", "Nothing to review") : t("Chưa có gì ở đây", "Nothing here yet")}
          action={
            tab === "review" && (
              <Link to="/jobs">
                <Button>{t("Tìm việc để chuẩn bị", "Find jobs to prepare")}</Button>
              </Link>
            )
          }
        >
          {tab === "review" && t("Bấm “Chuẩn bị” ở một việc làm, ApplyPilot sẽ viết hồ sơ và đặt vào đây để bạn duyệt.", "Click “Prepare” on a job; ApplyPilot drafts the application and puts it here for you.")}
        </Empty>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-zinc-100">
            {visible.map((a) => (
              <li key={a.id}>
                <button onClick={() => navigate(`/review/${a.id}`)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-zinc-50">
                  {a.score != null ? <ScoreBadge score={a.score} /> : <span className="w-10" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{a.title}</div>
                    <div className="truncate text-xs text-zinc-500">
                      {a.company} · {timeAgoT(t, a.submitted_at ?? a.updated_at)}
                    </div>
                    {a.status === "prepared" && a.missing.length > 0 && (
                      <div className="mt-0.5 truncate text-xs text-amber-700">{t(`${a.missing.length} câu cần bạn trả lời`, `${a.missing.length} question(s) need you`)}</div>
                    )}
                  </div>
                  {a.job_status === "closed" && <Badge tone="red">{t("Tin đã đóng", "Closed")}</Badge>}
                  <StatusBadge status={a.status} />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        title={live ? t("Duyệt và nộp các hồ sơ này?", "Approve and submit these?") : t("Chạy thử các hồ sơ này?", "Dry-run these applications?")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBatchOpen(false)}>
              {t("Huỷ", "Cancel")}
            </Button>
            <Button variant="primary" onClick={runBatch} loading={busy}>
              {live ? t("Duyệt & nộp", "Approve & submit") : t("Chạy thử", "Run dry run")}
            </Button>
          </>
        }
      >
        <p className="mb-3">
          {live
            ? t("Các hồ sơ đã điền đủ dưới đây sẽ được nộp. Hồ sơ có câu do AI soạn hoặc câu cá nhân chưa xem sẽ được bỏ qua để bạn duyệt riêng.", "These complete applications will be submitted. Any with AI-drafted or personal answers you haven't seen are skipped for individual review.")
            : t("Form sẽ được điền thử trong trình duyệt và chụp màn hình; không gửi gì cho nhà tuyển dụng.", "Forms are filled in a browser and screenshotted; nothing is sent to employers.")}
        </p>
        <ul className="space-y-1">
          {ready.slice(0, 25).map((a) => (
            <li key={a.id} className="truncate">
              · <span className="font-medium">{a.title}</span> — {a.company}
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
