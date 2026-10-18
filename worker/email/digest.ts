import type { Env } from "../env";
import { getMeta, getSettings } from "../db/profile";
import { errorMessage, now } from "../lib/util";

// Daily digest: new strong matches + applications waiting for review. Sent around 07:30 in
// the user's timezone, only when there is something new, via Cloudflare Email Service.

const DAY = 24 * 3600 * 1000;

interface DigestData {
  waiting: { id: string; title: string; company: string }[];
  attention: number;
  fresh: { job_id: string; score: number; title: string; company: string; location: string | null }[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function digestData(env: Env, userId: string, since: number): Promise<DigestData> {
  const [waiting, attention, fresh] = await Promise.all([
    env.DB.prepare(
      "SELECT a.id, j.title, j.company FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ? AND a.status = 'prepared' ORDER BY a.updated_at DESC LIMIT 10",
    )
      .bind(userId)
      .all<{ id: string; title: string; company: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE user_id = ? AND status IN ('needs_manual','failed')").bind(userId).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT m.job_id, m.score, j.title, j.company, j.location FROM matches m JOIN jobs j ON j.id = m.job_id
       LEFT JOIN applications a ON a.user_id = m.user_id AND a.job_id = m.job_id
       WHERE m.user_id = ? AND m.dismissed = 0 AND j.status = 'open' AND a.id IS NULL AND m.created_at > ? AND m.score >= 60
       ORDER BY m.score DESC LIMIT 8`,
    )
      .bind(userId, since)
      .all<{ job_id: string; score: number; title: string; company: string; location: string | null }>(),
  ]);
  return { waiting: waiting.results, attention: attention?.n ?? 0, fresh: fresh.results };
}

export function renderDigest(d: DigestData, locale: "vi" | "en", appUrl: string): { subject: string; html: string; text: string } | null {
  if (!d.waiting.length && !d.fresh.length && !d.attention) return null;
  const vi = locale === "vi";
  const t = (a: string, b: string) => (vi ? a : b);
  const subject = d.waiting.length
    ? t(`${d.waiting.length} hồ sơ chờ bạn duyệt · ${d.fresh.length} việc mới`, `${d.waiting.length} application(s) to review · ${d.fresh.length} new matches`)
    : t(`${d.fresh.length} việc làm mới phù hợp`, `${d.fresh.length} new job matches`);
  const btn = (href: string, label: string) =>
    `<a href="${esc(href)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px">${esc(label)}</a>`;
  const row = (title: string, sub: string, href: string, badge?: string) =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid #f1f1f3"><a href="${esc(href)}" style="color:#18181b;text-decoration:none;font-weight:600;font-size:14px">${esc(title)}</a><div style="color:#71717a;font-size:13px">${esc(sub)}</div></td><td style="text-align:right;padding:10px 0;border-bottom:1px solid #f1f1f3;font-weight:700;color:#059669;font-size:14px">${badge ? esc(badge) : ""}</td></tr>`;
  const section = (title: string, rows: string) => `<h2 style="font-size:15px;margin:24px 0 4px;color:#18181b">${esc(title)}</h2><table width="100%" cellspacing="0" cellpadding="0">${rows}</table>`;

  let html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#18181b">
<div style="font-weight:700;font-size:16px;margin-bottom:16px">ApplyPilot</div>`;
  const lines: string[] = [];
  if (d.waiting.length) {
    html += section(t("Chờ bạn duyệt", "Waiting for your review"), d.waiting.map((w) => row(w.title, w.company, `${appUrl}/review/${w.id}`)).join(""));
    html += `<div style="margin:16px 0">${btn(`${appUrl}/review/${d.waiting[0]!.id}`, t("Bắt đầu duyệt", "Start reviewing"))}</div>`;
    lines.push(t("Chờ bạn duyệt:", "Waiting for review:"), ...d.waiting.map((w) => `- ${w.title} — ${w.company}: ${appUrl}/review/${w.id}`));
  }
  if (d.attention) {
    html += `<p style="font-size:14px;color:#92400e;background:#fffbeb;padding:10px 12px;border-radius:8px">${esc(t(`${d.attention} hồ sơ cần bạn xử lý (CAPTCHA hoặc lỗi).`, `${d.attention} application(s) need you (CAPTCHA or error).`))}</p>`;
    lines.push(t(`${d.attention} hồ sơ cần bạn xử lý.`, `${d.attention} application(s) need you.`));
  }
  if (d.fresh.length) {
    html += section(t("Việc làm mới phù hợp", "New matches"), d.fresh.map((j) => row(j.title, [j.company, j.location].filter(Boolean).join(" · "), `${appUrl}/jobs?job=${j.job_id}`, String(j.score))).join(""));
    html += `<div style="margin:16px 0">${btn(`${appUrl}/jobs`, t("Xem tất cả việc làm", "See all jobs"))}</div>`;
    lines.push(t("Việc làm mới:", "New matches:"), ...d.fresh.map((j) => `- [${j.score}] ${j.title} — ${j.company}: ${appUrl}/jobs?job=${j.job_id}`));
  }
  html += `<p style="font-size:12px;color:#a1a1aa;margin-top:28px">${esc(t("Không có gì được nộp khi chưa có bạn duyệt. Tắt email này trong Tôi → Tự động & AI.", "Nothing is submitted without your approval. Turn this email off under Me → Automation & AI."))}</p></div>`;
  return { subject, html, text: lines.join("\n") };
}

function localHour(timezone: string, t = new Date()): number {
  try {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(t));
  } catch {
    return t.getUTCHours();
  }
}

export function emailConfigured(env: Env) {
  return !!env.EMAIL && !!env.DIGEST_FROM;
}

/** Hourly cron: send each opted-in user their digest once a day around 07:30 local time. */
export async function sendDueDigests(env: Env, force = false): Promise<number> {
  if (!emailConfigured(env)) return 0;
  const rows = await env.DB.prepare(
    "SELECT p.user_id, u.email, p.last_digest_at FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.onboarded_at IS NOT NULL AND p.last_digest_at < ?",
  )
    .bind(now() - 20 * 3600 * 1000)
    .all<{ user_id: string; email: string; last_digest_at: number }>();
  let sent = 0;
  for (const r of rows.results) {
    try {
      const [settings, meta] = await Promise.all([getSettings(env, r.user_id), getMeta(env, r.user_id)]);
      if (!settings.digestEnabled) continue;
      if (!force && localHour(meta.timezone) !== 7) continue;
      const msg = renderDigest(await digestData(env, r.user_id, r.last_digest_at || now() - DAY), meta.locale, env.APP_URL ?? "");
      // Record the attempt even when there is nothing to say, so the window moves forward.
      await env.DB.prepare("UPDATE profiles SET last_digest_at = ? WHERE user_id = ?").bind(now(), r.user_id).run();
      if (!msg) continue;
      await env.EMAIL!.send({ to: r.email, from: { email: env.DIGEST_FROM!, name: "ApplyPilot" }, subject: msg.subject, html: msg.html, text: msg.text });
      sent++;
    } catch (e) {
      console.error(JSON.stringify({ event: "digest_error", userId: r.user_id, error: errorMessage(e) }));
    }
  }
  return sent;
}
