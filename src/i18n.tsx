import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { Locale } from "../shared/types";

// Lightweight i18n: strings are written inline as t("Tiếng Việt", "English"), so every
// string always has both languages and there is no key dictionary to keep in sync.

type T = (vi: string, en: string) => string;
const Ctx = createContext<{ locale: Locale; setLocale: (l: Locale) => void; t: T }>({
  locale: "vi",
  setLocale: () => {},
  t: (vi) => vi,
});

const STORAGE_KEY = "applypilot.locale";

function initialLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "vi" || v === "en") return v;
  } catch {
    /* storage unavailable */
  }
  return "vi";
}

export function LocaleProvider({ children, onChange }: { children: ReactNode; onChange?: (l: Locale) => void }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback(
    (l: Locale) => {
      setLocaleState(l);
      try {
        localStorage.setItem(STORAGE_KEY, l);
      } catch {
        /* ignore */
      }
      document.documentElement.lang = l;
      onChange?.(l);
    },
    [onChange],
  );
  const t = useCallback<T>((vi, en) => (locale === "en" ? en : vi), [locale]);
  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export const useLocale = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;

export function timeAgoT(t: T, ms: number | null | undefined) {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return t("vừa xong", "just now");
  if (s < 3600) return t(`${Math.floor(s / 60)} phút trước`, `${Math.floor(s / 60)}m ago`);
  if (s < 86400) return t(`${Math.floor(s / 3600)} giờ trước`, `${Math.floor(s / 3600)}h ago`);
  if (s < 86400 * 30) return t(`${Math.floor(s / 86400)} ngày trước`, `${Math.floor(s / 86400)}d ago`);
  return new Date(ms).toLocaleDateString();
}
