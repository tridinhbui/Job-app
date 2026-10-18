import type { Env } from "../env";
import { decryptBytes, decryptString, encryptBytes, encryptString, isCurrentKey, keyring } from "./crypto";

// Gradual re-encryption after a key rotation. Runs in the daily cleanup while
// DATA_ENCRYPTION_KEY_PREV is set; each run handles a bounded batch so it stays cheap.

const ROWS_PER_RUN = 200;
const OBJECTS_PER_RUN = 100;

const COLUMNS: [table: string, key: string, cols: string[]][] = [
  ["profiles", "user_id", ["personal_enc", "resume_enc", "answers_enc"]],
  ["applications", "id", ["answers_enc"]],
];

export async function reencryptBatch(env: Env): Promise<{ rows: number; objects: number; done: boolean }> {
  if (!env.DATA_ENCRYPTION_KEY_PREV) return { rows: 0, objects: 0, done: true };
  const ring = keyring(env);
  let rows = 0;
  let pendingRows = false;
  for (const [table, pk, cols] of COLUMNS) {
    const list = await env.DB.prepare(`SELECT ${pk} AS id, ${cols.join(", ")} FROM ${table}`).all<Record<string, string | null>>();
    for (const r of list.results) {
      if (rows >= ROWS_PER_RUN) {
        pendingRows = true;
        break;
      }
      const updates: [string, string][] = [];
      for (const c of cols) {
        const v = r[c];
        if (v && !(await isCurrentKey(ring, v))) updates.push([c, await encryptString(ring, await decryptString(ring, v))]);
      }
      if (!updates.length) continue;
      await env.DB.prepare(`UPDATE ${table} SET ${updates.map(([c]) => `${c} = ?`).join(", ")} WHERE ${pk} = ?`)
        .bind(...updates.map(([, v]) => v), r.id)
        .run();
      rows++;
    }
  }

  // R2 objects: re-encrypt those that only the previous key can read.
  let objects = 0;
  let cursor: string | undefined;
  let pendingObjects = false;
  const current = env.DATA_ENCRYPTION_KEY;
  do {
    const page = await env.FILES.list({ prefix: "u/", cursor, include: ["customMetadata"] });
    for (const o of page.objects) {
      if (objects >= OBJECTS_PER_RUN) {
        pendingObjects = true;
        break;
      }
      if (o.customMetadata?.enc !== "v1") continue;
      const obj = await env.FILES.get(o.key);
      if (!obj) continue;
      const data = new Uint8Array(await obj.arrayBuffer());
      try {
        await decryptBytes(current, data); // already on the current key
        continue;
      } catch {
        /* needs re-encryption */
      }
      const plain = await decryptBytes(ring, data);
      await env.FILES.put(o.key, await encryptBytes(ring, plain), { customMetadata: obj.customMetadata });
      objects++;
    }
    cursor = page.truncated && !pendingObjects ? page.cursor : undefined;
  } while (cursor);

  return { rows, objects, done: !pendingRows && !pendingObjects };
}
