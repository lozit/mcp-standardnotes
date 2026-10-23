/**
 * Protocol 003 framing, decrypt-only: "003:<auth_hash>:<uuid>:<iv>:<ciphertext>[:<auth_params>]".
 * Same as the official app's Operator002.ts, which 003 inherits. See docs/protocol-004.md.
 */

import { aes256CbcDecrypt, bytesToString, fromBase64, fromHex, hmacSha256Verify } from "./crypto.js";

export interface LegacyItemsKey {
  uuid: string;
  itemsKey: Uint8Array;
  dataAuthenticationKey: Uint8Array;
  version: "003";
}

export interface LegacyItemInput {
  uuid: string;
  content: string;
  enc_item_key: string;
  items_key_id?: string | null;
}

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_32 = /^[0-9a-f]{32}$/i;

/** Returns null when the MAC does not verify, so the caller can try another key. */
export async function decryptString003(
  payload: string,
  key: { ek: Uint8Array; ak: Uint8Array },
  expectedUuid: string,
): Promise<string | null> {
  const parts = payload.split(":");
  if (parts.length < 5 || parts.length > 6 || parts[0] !== "003") {
    throw new Error(`Invalid 003 payload for ${expectedUuid}`);
  }
  const [, authHash, uuid, iv, ciphertext] = parts as [string, string, string, string, string];
  if (!HEX_64.test(authHash) || !HEX_32.test(iv)) {
    throw new Error(`Invalid 003 payload for ${expectedUuid}`);
  }
  const authentic = await hmacSha256Verify(
    await fromHex(authHash),
    `003:${uuid}:${iv}:${ciphertext}`,
    key.ak,
  );
  if (!authentic) return null;
  if (uuid !== expectedUuid) {
    throw new Error(`003 payload uuid mismatch: expected ${expectedUuid}, got ${uuid}`);
  }
  return bytesToString(aes256CbcDecrypt(await fromBase64(ciphertext), key.ek, await fromHex(iv)));
}

/** Items without `items_key_id` (common before 2020) try every 003 key. */
export async function decryptItemContent003(
  item: LegacyItemInput,
  legacyKeys: readonly LegacyItemsKey[],
): Promise<string> {
  const candidates = item.items_key_id
    ? legacyKeys.filter((k) => k.uuid === item.items_key_id)
    : legacyKeys;
  if (candidates.length === 0) {
    throw new Error(`No 003 items_key for ${item.uuid}`);
  }
  for (const k of candidates) {
    const itemKeyHex = await decryptString003(
      item.enc_item_key,
      { ek: k.itemsKey, ak: k.dataAuthenticationKey },
      item.uuid,
    );
    if (itemKeyHex === null) continue;
    if (!/^[0-9a-f]{128}$/i.test(itemKeyHex)) {
      throw new Error(`Malformed 003 item key for ${item.uuid}`);
    }
    const content = await decryptString003(
      item.content,
      { ek: await fromHex(itemKeyHex.slice(0, 64)), ak: await fromHex(itemKeyHex.slice(64)) },
      item.uuid,
    );
    if (content === null) {
      throw new Error(`003 content for ${item.uuid} failed authentication`);
    }
    return content;
  }
  throw new Error(`No 003 items_key authenticates ${item.uuid}`);
}
