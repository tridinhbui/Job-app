import { useState } from "react";
import { fmtMoney, useApi } from "../api";
import { useT } from "../i18n";
import { Card, CardHeader, cx, ErrorNote, Progress, Spinner } from "../ui";

interface Metrics {
  days: number;
  discovery: { total: number; ok: number; rate: number | null };
  preparation: { total: number; ok: number; rate: number | null; avgMs: number | null };
  formFill: { filled: number; failed: number; rate: number | null; topFailing: [string, number][] };
  submission: { total: number; ok: number; rate: number | null; outcomes: Record<string, number> };
  ai: { byTask: { task: string; cost: number; calls: number }[]; total: number; perApplication: number | null; allInPerPrepared: number | null };
  daily: { day: string; kind: string; status: string; n: number }[];
}

const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

function RateCard({ title, rate, detail }: { title: string; rate: number | null; detail: string }) {
  const tone = rate == null ? "zinc" : rate >= 0.9 ? "zinc" : rate >= 0.7 ? "amber" : "red";
  return (
    <Card>
      <div className="text-xs font-medium text-zinc-500">{title}</div>
      <div className={cx("mt-2 text-2xl font-semibold tabular-nums", tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-zinc-900")}>{pct(rate)}</div>
      <div className="mt-2">
        <Progress value={(rate ?? 0) * 100} tone={tone} />
      </div>
      <div className="mt-1.5 text-xs text-zinc-500">{detail}</div>
    </Card>
  );
}

export default function Monitoring() {
  const t = useT();
  const [days, setDays] = useState(30);
  const { data: m, error } = useApi<Metrics>(`/metrics?days=${days}`, { pollMs: 60_000 });
  if (error) return <ErrorNote message={error} />;
  if (!m) return <Spinner />;

  const outcomeLabel: Record<string, string> = {
    submitted: t("Đã nộp", "Submitted"),
    dry_run_ok: t("Chạy thử OK", "Dry run OK"),
    blocked: "CAPTCHA",
    validation_failed: t("Form báo lỗi", "Form errors"),
    unverified: t("Chưa xác nhận", "Unverified"),
    error: t("Lỗi", "Error"),
  };
  const outcomes = Object.entries(m.submission.outcomes);
  const totalOutcomes = outcomes.reduce((a, [, n]) => a + n, 0) || 1;
  const days14 = [...new Set(m.daily.map((d) => d.day))].slice(-14);
  const maxDay = Math.max(1, ...days14.map((day) => m.daily.filter((d) => d.day === day).reduce((a, d) => a + d.n, 0)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">{t("Sức khoẻ của quy trình tìm việc và nộp hồ sơ.", "Health of the job search and application pipeline.")}</p>
        <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 text-xs">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={cx("rounded-md px-2.5 py-1", days === d ? "bg-zinc-900 text-white" : "text-zinc-600")}>
              {t(`${d} ngày`, `${d} days`)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <RateCard title={t("Quét việc làm thành công", "Job discovery success")} rate={m.discovery.rate} detail={t(`${m.discovery.ok}/${m.discovery.total} lượt quét`, `${m.discovery.ok}/${m.discovery.total} crawls`)} />
        <RateCard
          title={t("Chuẩn bị hồ sơ thành công", "Preparation success")}
          rate={m.preparation.rate}
          detail={t(`${m.preparation.ok}/${m.preparation.total} hồ sơ`, `${m.preparation.ok}/${m.preparation.total} applications`) + (m.preparation.avgMs ? ` · ~${Math.round(m.preparation.avgMs / 1000)}s` : "")}
        />
        <RateCard title={t("Điền form thành công", "Form fields filled")} rate={m.formFill.rate} detail={t(`${m.formFill.filled} ô đúng · ${m.formFill.failed} ô lỗi`, `${m.formFill.filled} filled · ${m.formFill.failed} failed`)} />
        <RateCard title={t("Lượt nộp / chạy thử thành công", "Submit / dry-run success")} rate={m.submission.rate} detail={t(`${m.submission.ok}/${m.submission.total} lượt`, `${m.submission.ok}/${m.submission.total} runs`)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("Chi phí AI", "AI cost")} subtitle={t(`${m.days} ngày qua`, `Last ${m.days} days`)} />
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="text-xl font-semibold tabular-nums">{fmtMoney(m.ai.total, 3)}</div>
              <div className="text-[11px] text-zinc-500">{t("Tổng", "Total")}</div>
            </div>
            <div>
              <div className="text-xl font-semibold tabular-nums">{m.ai.perApplication == null ? "—" : fmtMoney(m.ai.perApplication, 4)}</div>
              <div className="text-[11px] text-zinc-500">{t("Mỗi hồ sơ (trực tiếp)", "Per application (direct)")}</div>
            </div>
            <div>
              <div className="text-xl font-semibold tabular-nums">{m.ai.allInPerPrepared == null ? "—" : fmtMoney(m.ai.allInPerPrepared, 4)}</div>
              <div className="text-[11px] text-zinc-500">{t("Mỗi hồ sơ (tính cả tìm việc)", "Per application (all-in)")}</div>
            </div>
          </div>
          <ul className="mt-4 space-y-1 text-xs text-zinc-600">
            {m.ai.byTask.map((x) => (
              <li key={x.task} className="flex justify-between">
                <span>{x.task}</span>
                <span className="tabular-nums">
                  {x.calls} · {fmtMoney(x.cost, 4)}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title={t("Kết quả nộp / chạy thử", "Submission outcomes")} />
          {outcomes.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("Chưa có lượt nào.", "No runs yet.")}</p>
          ) : (
            <ul className="space-y-2">
              {outcomes.map(([k, n]) => (
                <li key={k}>
                  <div className="flex justify-between text-xs">
                    <span>{outcomeLabel[k] ?? k}</span>
                    <span className="tabular-nums text-zinc-500">{n}</span>
                  </div>
                  <Progress value={(n / totalOutcomes) * 100} tone={k === "submitted" || k === "dry_run_ok" ? "zinc" : k === "blocked" || k === "unverified" ? "amber" : "red"} />
                </li>
              ))}
            </ul>
          )}
          {m.formFill.topFailing.length > 0 && (
            <>
              <div className="mt-4 mb-1 text-xs font-medium text-zinc-600">{t("Ô hay điền lỗi nhất", "Most frequently failing fields")}</div>
              <ul className="space-y-0.5 text-xs text-zinc-600">
                {m.formFill.topFailing.map(([f, n]) => (
                  <li key={f} className="flex justify-between gap-2">
                    <span className="truncate">{f}</span>
                    <span className="tabular-nums">{n}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title={t("Hoạt động theo ngày", "Daily activity")} subtitle={t("Chuẩn bị và nộp hồ sơ (14 ngày gần nhất có hoạt động)", "Preparations and submissions (last 14 active days)")} />
        {days14.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("Chưa có dữ liệu.", "No data yet.")}</p>
        ) : (
          <div className="flex h-28 items-end gap-1.5">
            {days14.map((day) => {
              const rows = m.daily.filter((d) => d.day === day);
              const ok = rows.filter((d) => d.status === "ok" || d.status === "submitted" || d.status === "dry_run_ok").reduce((a, d) => a + d.n, 0);
              const bad = rows.reduce((a, d) => a + d.n, 0) - ok;
              return (
                <div key={day} className="flex flex-1 flex-col justify-end" title={`${day}: ${ok} ok, ${bad} ${t("lỗi", "failed")}`}>
                  <div className="rounded-t-sm bg-red-400" style={{ height: `${(bad / maxDay) * 100}%` }} />
                  <div className="bg-zinc-800" style={{ height: `${(ok / maxDay) * 100}%` }} />
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
