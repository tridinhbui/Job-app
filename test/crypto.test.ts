import { describe, expect, it } from "vitest";
import { decryptBytes, decryptString, encryptBytes, encryptString, isCurrentKey, keyring } from "../worker/lib/crypto";

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

describe("encryption keyring", () => {
  const oldKey = key();
  const newKey = key();
  it("round-trips strings and bytes", async () => {
    expect(await decryptString(oldKey, await encryptString(oldKey, "secret"))).toBe("secret");
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(await decryptBytes(oldKey, await encryptBytes(oldKey, bytes))).toEqual(bytes);
  });
  it("reads old data during rotation and writes with the new key", async () => {
    const ring = keyring({ DATA_ENCRYPTION_KEY: newKey, DATA_ENCRYPTION_KEY_PREV: oldKey });
    const old = await encryptString(oldKey, "personal data");
    expect(await decryptString(ring, old)).toBe("personal data");
    expect(await isCurrentKey(ring, old)).toBe(false);
    const fresh = await encryptString(ring, "personal data");
    expect(await isCurrentKey(ring, fresh)).toBe(true);
    expect(await decryptString(newKey, fresh)).toBe("personal data");
    await expect(decryptString(oldKey, fresh)).rejects.toThrow();
  });
  it("rejects tampered ciphertext", async () => {
    const enc = await encryptString(oldKey, "x");
    const [v, iv, ct] = enc.split(".");
    const tampered = `${v}.${iv}.${ct!.slice(0, -4)}AAAA`;
    await expect(decryptString(oldKey, tampered)).rejects.toThrow();
  });
});
