import { defaultPreferences, defaultSettings, emptyPersonal, emptyResume, withDefaults } from "../../shared/defaults";
import type { BaseResume, PersonalInfo, Preferences, UserSettings } from "../../shared/types";
import type { Env } from "../env";
import { decryptJson, encryptJson } from "../lib/crypto";
import { now, safeJson, uuid } from "../lib/util";

export interface SavedAnswer {
  question: string; // label as seen on a form
  answer: string;
  updatedAt: number;
}

export interface Profile {
  userId: string;
  personal: PersonalInfo;
  resume: BaseResume;
  resumeVersion: number;
  preferences: Preferences;
  settings: UserSettings;
  answers: SavedAnswer[];
  matchWatermark: number;
}

const userIdCache = new Map<string, string>();

export function forgetUser(email: string) {
  userIdCache.delete(email);
}

export async function ensureUser(env: Env, email: string): Promise<string> {
  const cached = userIdCache.get(email);
  if (cached) return cached;
  let row = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (!row) {
    const id = uuid();
    const t = now();
    const personal = { ...emptyPersonal(), email };
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(id, email, t),
      env.DB.prepare(
        `INSERT OR IGNORE INTO profiles (user_id, personal_enc, preferences_json, settings_json, updated_at)
         SELECT id, ?, ?, ?, ? FROM users WHERE email = ?`,
      ).bind(
        await encryptJson(env.DATA_ENCRYPTION_KEY, personal),
        JSON.stringify(defaultPreferences()),
        JSON.stringify(defaultSettings(Number(env.DEFAULT_MONTHLY_BUDGET_USD) || 10)),
        t,
        email,
      ),
    ]);
    row = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  }
  if (!row) throw new Error("Failed to create user");
  userIdCache.set(email, row.id);
  return row.id;
}

interface ProfileRow {
  personal_enc: string | null;
  resume_enc: string | null;
  resume_version: number;
  preferences_json: string;
  answers_enc: string | null;
  settings_json: string;
  match_watermark: number;
}

export async function getProfile(env: Env, userId: string): Promise<Profile> {
  const row = await env.DB.prepare(
    "SELECT personal_enc, resume_enc, resume_version, preferences_json, answers_enc, settings_json, match_watermark FROM profiles WHERE user_id = ?",
  )
    .bind(userId)
    .first<ProfileRow>();
  if (!row) throw new Error("Profile not found");
  const key = env.DATA_ENCRYPTION_KEY;
  return {
    userId,
    personal: withDefaults(emptyPersonal(), await decryptJson(key, row.personal_enc, {})),
    resume: withDefaults(emptyResume(), await decryptJson(key, row.resume_enc, {})),
    resumeVersion: row.resume_version,
    preferences: withDefaults(defaultPreferences(), safeJson(row.preferences_json, {})),
    settings: withDefaults(defaultSettings(Number(env.DEFAULT_MONTHLY_BUDGET_USD) || 10), safeJson(row.settings_json, {})),
    answers: await decryptJson<SavedAnswer[]>(key, row.answers_enc, []),
    matchWatermark: row.match_watermark,
  };
}

export async function getSettings(env: Env, userId: string): Promise<UserSettings> {
  const row = await env.DB.prepare("SELECT settings_json FROM profiles WHERE user_id = ?")
    .bind(userId)
    .first<{ settings_json: string }>();
  return withDefaults(defaultSettings(Number(env.DEFAULT_MONTHLY_BUDGET_USD) || 10), safeJson(row?.settings_json, {}));
}

export async function savePersonal(env: Env, userId: string, personal: PersonalInfo) {
  await env.DB.prepare("UPDATE profiles SET personal_enc = ?, updated_at = ? WHERE user_id = ?")
    .bind(await encryptJson(env.DATA_ENCRYPTION_KEY, personal), now(), userId)
    .run();
}

/** Saving the resume bumps its version and resets the match watermark (full re-match). */
export async function saveResume(env: Env, userId: string, resume: BaseResume): Promise<number> {
  const row = await env.DB.prepare(
    "UPDATE profiles SET resume_enc = ?, resume_version = resume_version + 1, match_watermark = 0, updated_at = ? WHERE user_id = ? RETURNING resume_version",
  )
    .bind(await encryptJson(env.DATA_ENCRYPTION_KEY, resume), now(), userId)
    .first<{ resume_version: number }>();
  return row?.resume_version ?? 0;
}

export async function savePreferences(env: Env, userId: string, prefs: Preferences) {
  await env.DB.prepare("UPDATE profiles SET preferences_json = ?, match_watermark = 0, updated_at = ? WHERE user_id = ?")
    .bind(JSON.stringify(prefs), now(), userId)
    .run();
}

export async function saveSettings(env: Env, userId: string, settings: UserSettings) {
  await env.DB.prepare("UPDATE profiles SET settings_json = ?, updated_at = ? WHERE user_id = ?")
    .bind(JSON.stringify(settings), now(), userId)
    .run();
}

export async function saveAnswers(env: Env, userId: string, answers: SavedAnswer[]) {
  await env.DB.prepare("UPDATE profiles SET answers_enc = ?, updated_at = ? WHERE user_id = ?")
    .bind(await encryptJson(env.DATA_ENCRYPTION_KEY, answers.slice(0, 300)), now(), userId)
    .run();
}

/** Compare-and-set so a concurrent reset (resume/preferences edit) is never overwritten. */
export async function setWatermark(env: Env, userId: string, expected: number, watermark: number) {
  await env.DB.prepare("UPDATE profiles SET match_watermark = ? WHERE user_id = ? AND match_watermark = ?")
    .bind(watermark, userId, expected)
    .run();
}
