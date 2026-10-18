// AES-256-GCM envelope for personal data at rest (D1 columns and R2 objects).
// Format for strings: "v1.<iv b64>.<ciphertext b64>". Binary: 1-byte version + 12-byte IV + ciphertext.

let cached: { raw: string; key: CryptoKey } | null = null;

async function getKey(raw: string): Promise<CryptoKey> {
  if (cached?.raw === raw) return cached.key;
  if (!raw) throw new Error("DATA_ENCRYPTION_KEY is not configured");
  const bytes = b64decode(raw);
  if (bytes.byteLength !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes (base64)");
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  cached = { raw, key };
  return key;
}

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptBytes(rawKey: string, plain: Uint8Array): Promise<Uint8Array> {
  const key = await getKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

export async function decryptBytes(rawKey: string, data: Uint8Array): Promise<Uint8Array> {
  if (data[0] !== 1) throw new Error("Unknown ciphertext version");
  const key = await getKey(rawKey);
  const iv = data.slice(1, 13);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data.slice(13));
  return new Uint8Array(pt);
}

export async function encryptString(rawKey: string, plain: string): Promise<string> {
  const key = await getKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `v1.${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

export async function decryptString(rawKey: string, enc: string): Promise<string> {
  const [v, ivB64, ctB64] = enc.split(".");
  if (v !== "v1" || !ivB64 || !ctB64) throw new Error("Unknown ciphertext format");
  const key = await getKey(rawKey);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(ivB64) }, key, b64decode(ctB64));
  return new TextDecoder().decode(pt);
}

export async function encryptJson(rawKey: string, value: unknown): Promise<string> {
  return encryptString(rawKey, JSON.stringify(value));
}

export async function decryptJson<T>(rawKey: string, enc: string | null | undefined, fallback: T): Promise<T> {
  if (!enc) return fallback;
  return JSON.parse(await decryptString(rawKey, enc)) as T;
}
