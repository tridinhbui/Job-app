import { Briefcase, Home, Inbox, Menu, ShieldCheck, UserRound } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";
import type { Locale, UsageSummary } from "../shared/types";
import { api, fmtMoney, useApi } from "./api";
import { LocaleProvider, useLocale, useT } from "./i18n";
import Applications from "./pages/Applications";
import Jobs from "./pages/Jobs";
import Me from "./pages/Me";
import Onboarding from "./pages/Onboarding";
import ReviewScreen from "./pages/ReviewScreen";
import Today from "./pages/Today";
import { cx, ErrorNote, Progress, Spinner } from "./ui";

export interface MeData {
  email: string;
  userId: string;
  submitMode: "dry_run" | "live";
  liveSubmitEnabled: boolean;
  usage: UsageSummary;
  locale: Locale;
  timezone: string;
  onboarded: boolean;
  emailConfigured: boolean;
}

const MeCtx = createContext<{ me: MeData | null; reloadMe: () => void }>({ me: null, reloadMe: () => {} });
export const useMe = () => useContext(MeCtx);

function LangToggle() {
  const { locale, setLocale } = useLocale();
  return (
    <div className="flex rounded-md bg-zinc-100 p-0.5 text-[11px] font-semibold">
      {(["vi", "en"] as const).map((l) => (
        <button key={l} onClick={() => setLocale(l)} className={cx("rounded px-1.5 py-0.5 uppercase", locale === l ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500")}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Sidebar({ me, onNavigate }: { me: MeData | null; onNavigate?: () => void }) {
  const t = useT();
  const nav = [
    { to: "/", label: t("Hôm nay", "Today"), icon: Home },
    { to: "/jobs", label: t("Việc làm", "Jobs"), icon: Briefcase },
    { to: "/applications", label: t("Hồ sơ ứng tuyển", "Applications"), icon: Inbox },
    { to: "/me", label: t("Tôi", "Me"), icon: UserRound },
  ];
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
        <div className="text-sm font-semibold tracking-tight">ApplyPilot</div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition",
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
          <div title={t("Chi phí AI tháng này", "AI spend this month")}>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="font-medium text-zinc-700">{t("Chi phí AI", "AI spend")}</span>
              <span className="tabular-nums text-zinc-500">
                {fmtMoney(u.spentUsd)} / {fmtMoney(u.budgetUsd, 0)}
              </span>
            </div>
            <Progress value={pct} tone={pct >= 100 ? "red" : pct >= 60 ? "amber" : "zinc"} />
          </div>
        )}
        {me && (
          <div className="flex items-center justify-between gap-2">
            <span
              className={cx(
                "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                me.submitMode === "live" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700",
              )}
              title={me.submitMode === "live" ? t("Có thể nộp thật sau khi bạn duyệt", "Real submission possible after your approval") : t("Chạy thử: không bao giờ bấm nộp", "Dry run: submit is never clicked")}
            >
              <ShieldCheck className="h-3 w-3" />
              {me.submitMode === "live" ? t("Nộp thật", "Live") : t("Chạy thử", "Dry run")}
            </span>
            <LangToggle />
          </div>
        )}
        {me && (
          <div className="truncate text-[11px] text-zinc-400" title={me.email}>
            {me.email}
          </div>
        )}
      </div>
    </div>
  );
}

function Shell() {
  const { data: me, error, reload } = useApi<MeData>("/me", { pollMs: 60_000 });
  const [mobileOpen, setMobileOpen] = useState(false);
  const t = useT();

  if (error) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorNote message={`${t("Không tải được tài khoản", "Could not load your account")}: ${error}`} />
      </div>
    );
  }
  if (!me) return <Spinner />;
  if (!me.onboarded) return <Onboarding onDone={() => void reload(true)} />;

  return (
    <MeCtx.Provider value={{ me, reloadMe: () => void reload(true) }}>
      <div className="min-h-screen">
        <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-zinc-200/80 bg-zinc-50 lg:block">
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
        <div className="lg:pl-60">
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-zinc-200/80 bg-white/80 px-4 py-3 backdrop-blur lg:hidden">
            <button onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100" aria-label="Menu">
              <Menu className="h-5 w-5" />
            </button>
            <span className="text-sm font-semibold">ApplyPilot</span>
          </header>
          <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
            <Routes>
              <Route path="/" element={<Today />} />
              <Route path="/jobs" element={<Jobs />} />
              <Route path="/applications" element={<Applications />} />
              <Route path="/review/:id" element={<ReviewScreen />} />
              <Route path="/me" element={<Me />} />
              {/* v1 paths */}
              <Route path="/discovery" element={<Navigate to="/jobs" replace />} />
              <Route path="/queue" element={<Navigate to="/applications" replace />} />
              <Route path="/tracker" element={<Navigate to="/applications" replace />} />
              <Route path="/resume" element={<Navigate to="/me" replace />} />
              <Route path="/settings" element={<Navigate to="/me" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </MeCtx.Provider>
  );
}

export default function App() {
  const onLocale = (locale: Locale) => {
    void api("/profile/locale", { method: "PUT", json: { locale, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }).catch(() => {});
  };
  return (
    <LocaleProvider onChange={onLocale}>
      <Shell />
    </LocaleProvider>
  );
}
