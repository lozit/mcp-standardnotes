import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// libsodium-wrappers-sumo ships a broken ESM build; force CJS load.
const sodium = require("libsodium-wrappers-sumo") as typeof import("libsodium-wrappers-sumo");

let ready: Promise<void> | null = null;

export async function sodiumReady(): Promise<typeof sodium> {
  if (!ready) ready = sodium.ready;
  await ready;
  return sodium;
}

export async function sha256Hex(input: string): Promise<string> {
  const s = await sodiumReady();
  return s.to_hex(s.crypto_hash_sha256(input));
}

/**
 * Argon2id KDF per SN protocol 004.
 * - salt: 16 bytes
 * - memLimit / opsLimit from server key params
 * - output: 64 bytes (split 32/32 → masterKey / serverPassword, hex)
 */
export async function argon2id64(
  password: string,
  saltBytes: Uint8Array,
  opsLimit: number,
  memLimitBytes: number,
): Promise<Uint8Array> {
  const s = await sodiumReady();
  if (saltBytes.length !== s.crypto_pwhash_SALTBYTES) {
    throw new Error(
      `salt must be ${s.crypto_pwhash_SALTBYTES} bytes, got ${saltBytes.length}`,
    );
  }
  return s.crypto_pwhash(
    64,
    password,
    saltBytes,
    opsLimit,
    memLimitBytes,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function xchachaEncrypt(
  plaintext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const s = await sodiumReady();
  return s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    key,
  );
}

export async function xchachaDecrypt(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const s = await sodiumReady();
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    aad,
    nonce,
    key,
  );
}

export async function randomBytes(n: number): Promise<Uint8Array> {
  const s = await sodiumReady();
  return s.randombytes_buf(n);
}

export async function fromHex(hex: string): Promise<Uint8Array> {
  const s = await sodiumReady();
  return s.from_hex(hex);
}

export async function toHex(bytes: Uint8Array): Promise<string> {
  const s = await sodiumReady();
  return s.to_hex(bytes);
}

export async function fromBase64(b64: string): Promise<Uint8Array> {
  const s = await sodiumReady();
  return s.from_base64(b64, s.base64_variants.ORIGINAL);
}

export async function toBase64(bytes: Uint8Array): Promise<string> {
  const s = await sodiumReady();
  return s.to_base64(bytes, s.base64_variants.ORIGINAL);
}

export async function stringToBytes(s: string): Promise<Uint8Array> {
  return new TextEncoder().encode(s);
}

export function bytesToString(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
