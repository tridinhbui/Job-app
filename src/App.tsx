import { Compass, FileText, Inbox, KanbanSquare, LayoutDashboard, Menu, Settings as SettingsIcon, ShieldCheck } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router";
import type { UsageSummary } from "../shared/types";
import { fmtMoney, useApi } from "./api";
import Discovery from "./pages/Discovery";
import Overview from "./pages/Overview";
import Queue from "./pages/Queue";
import ResumeStudio from "./pages/ResumeStudio";
import Settings from "./pages/Settings";
import Tracker from "./pages/Tracker";
import { cx, ErrorNote, Progress, Spinner } from "./ui";

export interface Me {
  email: string;
  userId: string;
  submitMode: "dry_run" | "live";
  usage: UsageSummary;
}

const MeCtx = createContext<{ me: Me | null; reloadMe: () => void }>({ me: null, reloadMe: () => {} });
export const useMe = () => useContext(MeCtx);

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/discovery", label: "Job Discovery", icon: Compass },
  { to: "/queue", label: "Application Queue", icon: Inbox },
  { to: "/resume", label: "Resume Studio", icon: FileText },
  { to: "/tracker", label: "Tracker", icon: KanbanSquare },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

const MODE_LABEL: Record<UsageSummary["mode"], string> = {
  normal: "AI budget healthy",
  conserve: "Conserving: match reasoning paused",
  essential: "Essential AI only",
  exhausted: "Budget reached: deterministic mode",
  disabled: "AI disabled",
};

function Sidebar({ me, onNavigate }: { me: Me | null; onNavigate?: () => void }) {
  const u = me?.usage;
  const pct = u && u.budgetUsd > 0 ? (u.spentUsd / u.budgetUsd) * 100 : 0;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900">
          <svg viewBox="0 0 32 32" className="h-5 w-5">
            <path d="M9 21.5 16 8l7 13.5-7-3.2-7 3.2Z" fill="#fff" />
          </svg>
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">ApplyPilot</div>
          <div className="text-[11px] text-zinc-500">Job application agent</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
                isActive ? "bg-white font-medium text-zinc-900 shadow-sm ring-1 ring-zinc-200" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-3 border-t border-zinc-200/80 p-4">
        {u && (
          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="font-medium text-zinc-700">AI spend · {u.month}</span>
              <span className="tabular-nums text-zinc-500">
                {fmtMoney(u.spentUsd)} / {fmtMoney(u.budgetUsd, 0)}
              </span>
            </div>
            <Progress value={pct} tone={pct >= 100 ? "red" : pct >= 60 ? "amber" : "zinc"} />
            <div className="mt-1.5 text-[11px] text-zinc-500">{MODE_LABEL[u.mode]}</div>
          </div>
        )}
        {me && (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-zinc-500" title={me.email}>
              {me.email}
            </span>
            <span
              className={cx(
                "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                me.submitMode === "live" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700",
              )}
              title={me.submitMode === "live" ? "Live submission is possible after your approval" : "Dry-run: the submit button is never clicked"}
            >
              <ShieldCheck className="h-3 w-3" />
              {me.submitMode === "live" ? "Live" : "Dry run"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const { data: me, error, reload } = useApi<Me>("/me", { pollMs: 60_000 });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  return (
    <MeCtx.Provider value={{ me, reloadMe: () => void reload(true) }}>
      <div className="min-h-screen">
        <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-zinc-200/80 bg-zinc-50 lg:block">
          <Sidebar me={me} />
        </aside>
        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-zinc-900/30" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 w-64 bg-zinc-50 shadow-xl">
              <Sidebar me={me} onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        )}
        <div className="lg:pl-64">
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-zinc-200/80 bg-white/80 px-4 py-3 backdrop-blur lg:hidden">
            <button onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100" aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </button>
            <span className="text-sm font-semibold">ApplyPilot</span>
          </header>
          <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
            {error ? (
              <ErrorNote message={`Could not load your account: ${error}. If this deployment uses Cloudflare Access, sign in again.`} />
            ) : !me ? (
              <Spinner />
            ) : (
              <Routes location={location}>
                <Route path="/" element={<Overview />} />
                <Route path="/discovery" element={<Discovery />} />
                <Route path="/queue" element={<Queue />} />
                <Route path="/resume" element={<ResumeStudio />} />
                <Route path="/tracker" element={<Tracker />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Overview />} />
              </Routes>
            )}
          </main>
        </div>
      </div>
    </MeCtx.Provider>
  );
}
