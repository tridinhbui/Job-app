import { Check, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { CATALOG } from "../../shared/catalog";
import { api } from "../api";
import { useT } from "../i18n";
import { Button, cx, inputCls, useToast } from "../ui";

export const catalogId = (c: { ats: string; token: string }) => `${c.ats}:${c.token}`;

/**
 * Grid of curated companies with search and category filter, plus a free-form box that
 * accepts a company name or any careers / job-board link (detected server-side).
 */
export function CompanyPicker({ selected, onToggle, onAdded }: { selected: Set<string>; onToggle: (id: string) => void; onAdded?: (id: string, name: string) => void }) {
  const t = useT();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [custom, setCustom] = useState("");
  const [adding, setAdding] = useState(false);
  const categories = useMemo(() => [...new Set(CATALOG.map((c) => c.category))], []);
  const shown = CATALOG.filter((c) => (!cat || c.category === cat) && (!q || c.name.toLowerCase().includes(q.toLowerCase())));

  const addCustom = async () => {
    setAdding(true);
    try {
      const r = await api<{ id: string; name: string | null }>("/sources", { method: "POST", json: { query: custom, companyName: "" } });
      toast(t(`Đã thêm ${r.name ?? custom}`, `Added ${r.name ?? custom}`));
      onAdded?.(r.id, r.name ?? custom);
      setCustom("");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input className={cx(inputCls, "pl-9")} placeholder={t("Tìm công ty", "Search companies")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1">
          {["", ...categories].map((c) => (
            <button key={c || "all"} onClick={() => setCat(c)} className={cx("rounded-md px-2.5 py-1.5 text-xs", cat === c ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200")}>
              {c || t("Tất cả", "All")}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {shown.map((c) => {
          const id = catalogId(c);
          const on = selected.has(id);
          return (
            <button
              key={id}
              onClick={() => onToggle(id)}
              className={cx(
                "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition",
                on ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white hover:border-zinc-300",
              )}
            >
              <span className={cx("flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold", on ? "bg-white/15" : "bg-zinc-100 text-zinc-600")}>
                {on ? <Check className="h-4 w-4" /> : c.name.slice(0, 2)}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{c.name}</span>
                <span className={cx("block truncate text-[11px]", on ? "text-white/70" : "text-zinc-400")}>{c.category}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 rounded-lg bg-zinc-50 p-3">
        <input
          className={cx(inputCls, "min-w-[220px] flex-1")}
          placeholder={t("Công ty khác: nhập tên hoặc dán link trang tuyển dụng", "Another company: type a name or paste a careers link")}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && custom.trim() && void addCustom()}
        />
        <Button onClick={addCustom} loading={adding} disabled={!custom.trim()}>
          <Plus className="h-3.5 w-3.5" /> {t("Thêm", "Add")}
        </Button>
      </div>
    </div>
  );
}
