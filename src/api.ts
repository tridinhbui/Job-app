import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Minimal data hook: fetch on mount / dependency change, with manual reload and optional polling. */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!path) return;
      const id = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const d = await api<T>(path);
        if (id === seq.current) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (id === seq.current) setError((e as Error).message);
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!opts.pollMs || !path) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, opts.pollMs);
    return () => clearInterval(t);
  }, [opts.pollMs, path, load]);

  return { data, error, loading, reload: load, setData };
}

export const fmtMoney = (n: number, digits = 2) => `$${n.toFixed(digits)}`;

export function fmtSalary(min: number | null, max: number | null, currency: string | null, period: string | null) {
  if (!min && !max) return null;
  const sym = currency === "USD" || !currency ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : `${currency} `;
  const f = (n: number) => (period === "hour" ? n.toFixed(0) : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const range = min && max && min !== max ? `${sym}${f(min)}–${f(max)}` : `${sym}${f((max ?? min)!)}`;
  return `${range}${period === "hour" ? "/hr" : period === "month" ? "/mo" : ""}`;
}

export function timeAgo(ms: number | null | undefined) {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}
