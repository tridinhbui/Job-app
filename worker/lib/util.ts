export const now = () => Date.now();

/** UTC month key, e.g. "2026-10". */
export const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

export const uuid = () => crypto.randomUUID();

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Cheap HTML -> readable plain text (keeps list items and paragraph breaks). */
export function htmlToText(html: string): string {
  let s = html;
  // Greenhouse returns entity-escaped HTML; decode once if it looks escaped.
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|section)>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) : s;
}

export function normalizeSpace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}
