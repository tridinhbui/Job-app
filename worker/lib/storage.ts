import type { Env } from "../env";
import { decryptBytes, encryptBytes, keyring } from "./crypto";

// All objects are stored encrypted and namespaced by user id: "u/<userId>/...".
// Objects are only ever served through authenticated API routes that check ownership.

export const userKey = (userId: string, path: string) => `u/${userId}/${path}`;

export async function putPrivate(env: Env, key: string, data: Uint8Array | string, contentType: string) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const enc = await encryptBytes(keyring(env), bytes);
  await env.FILES.put(key, enc, { customMetadata: { contentType, enc: "v1" } });
}

export async function getPrivate(env: Env, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const obj = await env.FILES.get(key);
  if (!obj) return null;
  const raw = new Uint8Array(await obj.arrayBuffer());
  const bytes = obj.customMetadata?.enc === "v1" ? await decryptBytes(keyring(env), raw) : raw;
  return { bytes, contentType: obj.customMetadata?.contentType ?? "application/octet-stream" };
}

export async function getPrivateJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await getPrivate(env, key);
  return obj ? (JSON.parse(new TextDecoder().decode(obj.bytes)) as T) : null;
}

export async function deletePrefix(env: Env, prefix: string) {
  let cursor: string | undefined;
  do {
    const list = await env.FILES.list({ prefix, cursor });
    if (list.objects.length) await env.FILES.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
