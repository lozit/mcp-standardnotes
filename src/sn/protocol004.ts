/**
 * Standard Notes protocol 004 framing.
 *
 * Payload content format (string):
 *   "004:<nonce_hex>:<ciphertext_b64>:<aad_b64>"
 *
 * AAD is a JSON object, authenticated as associated data of XChaCha20-Poly1305:
 *   { u: <item_uuid>, v: "004", kp: <keyParams_for_items_keys | items_key_uuid_for_others> }
 *
 * Keys:
 *   - rootKey: derived from user password via Argon2id. 64 bytes split into
 *     masterKey (first 32, hex) and serverPassword (last 32, hex).
 *   - items_key items are encrypted with rootKey.masterKey. Their AAD kp
 *     contains the account keyParams.
 *   - other items are encrypted with the referenced items_key.itemsKey.
 *     Their AAD kp contains the items_key uuid as a string.
 *
 * Spec reference: https://standardnotes.com/help/security/encryption
 */

import {
  argon2id64,
  bytesToString,
  fromBase64,
  fromHex,
  randomBytes,
  sha256Hex,
  stringToBytes,
  toBase64,
  toHex,
  xchachaDecrypt,
  xchachaEncrypt,
} from "./crypto.js";
import type { NoteType } from "./types.js";

const SN_APP_DOMAIN = "org.standardnotes.sn";

const EDITOR_IDENTIFIERS: Partial<Record<NoteType, string>> = {
  markdown: "org.standardnotes.advanced-markdown-editor",
  super: "com.standardnotes.super-editor",
  code: "org.standardnotes.code-editor",
};

export interface KeyParams004 {
  version: "004";
  identifier: string;
  pw_nonce: string;
  origination?: string;
  created?: string;
}

export interface RootKey {
  masterKey: Uint8Array;
  serverPassword: string;
  keyParams: KeyParams004;
}

const NONCE_BYTES = 24;
const KEY_BYTES = 32;

export async function deriveRootKey(
  password: string,
  keyParams: KeyParams004,
): Promise<RootKey> {
  if (keyParams.version !== "004") {
    throw new Error(
      `Only protocol 004 is supported; got version ${keyParams.version}. ` +
        "Upgrade your account via the Standard Notes app first.",
    );
  }
  // Use identifier verbatim as returned by the server (do not lowercase).
  const saltInput = `${keyParams.identifier}:${keyParams.pw_nonce}`;
  const saltHex = (await sha256Hex(saltInput)).substring(0, 32);
  const saltBytes = await fromHex(saltHex);

  // SN 004 fixed Argon2id parameters (see whitepaper):
  const OPS_LIMIT = 5;
  const MEM_LIMIT = 64 * 1024 * 1024;

  const derived = await argon2id64(password, saltBytes, OPS_LIMIT, MEM_LIMIT);
  const masterKey = derived.slice(0, KEY_BYTES);
  const serverPasswordBytes = derived.slice(KEY_BYTES, KEY_BYTES * 2);
  const serverPassword = await toHex(serverPasswordBytes);
  return { masterKey, serverPassword, keyParams };
}

export interface ParsedPayload {
  version: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  /** The raw base64 string of authenticated_data — this IS what xchacha20 uses as AAD. */
  aadB64: string;
  /** Decoded JSON of authenticated_data (for inspection: u, v, kp). */
  aad: Record<string, unknown>;
  additionalDataB64: string;
}

// 004 symmetric payload format: "version:nonce:ciphertext:aad[:additionalData]"
// The 5th (additionalData) is optional; older payloads omit it.
export async function parseEncryptedString(
  content: string,
): Promise<ParsedPayload> {
  if (content.startsWith("004_Asym:")) {
    throw new Error(
      "Asymmetric 004 payload (shared vault invite) is not supported",
    );
  }
  const parts = content.split(":");
  if (parts.length !== 4 && parts.length !== 5) {
    throw new Error(
      `Invalid 004 payload: expected 4 or 5 parts, got ${parts.length}`,
    );
  }
  const [version, nonceHex, ctB64, aadB64] = parts as [
    string,
    string,
    string,
    string,
  ];
  const additionalDataB64 = parts[4] ?? "e30=";
  if (version !== "004") {
    throw new Error(`Unsupported payload version: ${version}`);
  }
  const aadDecodedBytes = await fromBase64(aadB64);
  const aadJson = bytesToString(aadDecodedBytes);
  let aad: Record<string, unknown>;
  try {
    aad = JSON.parse(aadJson) as Record<string, unknown>;
  } catch {
    throw new Error("004 payload AAD is not valid JSON");
  }
  return {
    version,
    nonce: await fromHex(nonceHex),
    ciphertext: await fromBase64(ctB64),
    aadB64,
    aad,
    additionalDataB64,
  };
}

/**
 * `JSON.parse` for already-decrypted item content. The plaintext is
 * AEAD-authenticated (XChaCha20-Poly1305) — only data encrypted under our own
 * key reaches here, so it can't be attacker-forged — but a genuinely corrupt
 * item would make `JSON.parse` throw an opaque `SyntaxError`. Wrapping it names
 * the offending item and kind, so the per-item `catch` in `fullSync` skips it
 * cleanly instead of surfacing a context-free parser error.
 */
function parseDecryptedContent<T>(json: string, kind: string, uuid: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Decrypted ${kind} content for ${uuid} is not valid JSON`);
  }
}

export async function decryptString(
  content: string,
  key: Uint8Array,
  expectedUuid: string,
): Promise<string> {
  const p = await parseEncryptedString(content);
  if (p.aad["u"] !== expectedUuid) {
    throw new Error(
      `Payload AAD uuid mismatch: expected ${expectedUuid}, got ${String(p.aad["u"])}`,
    );
  }
  // AAD for xchacha20 = UTF-8 bytes of the base64 string itself (SN convention).
  const aadBytes = await stringToBytes(p.aadB64);
  const plain = await xchachaDecrypt(p.ciphertext, aadBytes, p.nonce, key);
  return bytesToString(plain);
}

export async function encryptString(
  plaintext: string,
  key: Uint8Array,
  aadObject: Record<string, unknown>,
): Promise<string> {
  const nonce = await randomBytes(NONCE_BYTES);
  const aadJson = JSON.stringify(aadObject);
  const aadB64 = await toBase64(await stringToBytes(aadJson));
  // AAD for xchacha20 = bytes of the base64 string, not of the JSON itself.
  const aadForAead = await stringToBytes(aadB64);
  const ct = await xchachaEncrypt(
    await stringToBytes(plaintext),
    aadForAead,
    nonce,
    key,
  );
  const EMPTY_ADDITIONAL = "e30=";
  return `004:${await toHex(nonce)}:${await toBase64(ct)}:${aadB64}:${EMPTY_ADDITIONAL}`;
}

export async function generateItemsKeyRaw(): Promise<Uint8Array> {
  return randomBytes(KEY_BYTES);
}

export interface EncryptedItemInput {
  uuid: string;
  content_type: string;
  content: string;
  enc_item_key: string;
  items_key_id?: string | null;
  created_at?: string;
  updated_at?: string;
  created_at_timestamp?: number;
  updated_at_timestamp?: number;
  deleted?: boolean;
}

export interface DecryptedItemsKey {
  uuid: string;
  itemsKey: Uint8Array;
  version: "004";
}

/**
 * Decrypts an items_key item (content_type = "SN|ItemsKey").
 *
 *   - enc_item_key : encrypted under rootKey.masterKey → yields hex of a
 *                    "wrapping" key K1 used only to decrypt this item's `content`.
 *   - content      : encrypted under K1 → JSON whose `itemsKey` field contains
 *                    the ACTUAL items_key (K2) used to wrap other items.
 *
 * Only K2 is kept and exposed as the items_key for note decryption.
 */
export async function decryptItemsKey(
  item: EncryptedItemInput,
  rootKey: RootKey,
): Promise<DecryptedItemsKey> {
  const wrappingKeyHex = await decryptString(
    item.enc_item_key,
    rootKey.masterKey,
    item.uuid,
  );
  const wrappingKey = await fromHex(wrappingKeyHex);

  const contentJson = await decryptString(item.content, wrappingKey, item.uuid);
  const content = parseDecryptedContent<{
    version?: string;
    itemsKey?: string;
  }>(contentJson, "items_key", item.uuid);
  if (content.version && content.version !== "004") {
    throw new Error(`items_key has non-004 version: ${content.version}`);
  }
  if (!content.itemsKey || !/^[0-9a-f]{64}$/i.test(content.itemsKey)) {
    throw new Error(
      `items_key content missing valid 'itemsKey' field for ${item.uuid}`,
    );
  }
  const itemsKey = await fromHex(content.itemsKey);
  return { uuid: item.uuid, itemsKey, version: "004" };
}

export interface DecryptedNote {
  uuid: string;
  title: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  trashed: boolean;
  // Top-level `protected` on the note content — SN requires re-auth in the
  // app before showing content. We surface this so the tool layer can refuse
  // to leak it to an LLM context.
  protected: boolean;
  // Edit-lock under appData["org.standardnotes.sn"].locked — read-only flag,
  // content stays readable, only writes are forbidden.
  locked: boolean;
  noteType: NoteType;
  updated_at_timestamp: number;
  created_at_timestamp: number;
}

export async function decryptNote(
  item: EncryptedItemInput,
  itemsKeyByUuid: Map<string, Uint8Array>,
): Promise<DecryptedNote> {
  const keyId = item.items_key_id;
  if (!keyId) {
    throw new Error(`Note ${item.uuid} has no items_key_id`);
  }
  const itemsKey = itemsKeyByUuid.get(keyId);
  if (!itemsKey) {
    throw new Error(`Unknown items_key ${keyId} for note ${item.uuid}`);
  }
  const itemKeyHex = await decryptString(
    item.enc_item_key,
    itemsKey,
    item.uuid,
  );
  const perItemKey = await fromHex(itemKeyHex);
  const contentJson = await decryptString(
    item.content,
    perItemKey,
    item.uuid,
  );
  const content = parseDecryptedContent<{
    title?: string;
    text?: string;
    trashed?: boolean;
    protected?: boolean;
    appData?: Record<string, Record<string, unknown> | undefined>;
    noteType?: string;
  }>(contentJson, "note", item.uuid);
  // SN stores the edit-lock under the appData domain "org.standardnotes.sn".
  // Anything else (legacy keys, future extension points) we deliberately
  // ignore here — the field is exposed only as a boolean to the tool layer.
  const snAppData = content.appData?.["org.standardnotes.sn"];
  const locked =
    typeof snAppData === "object" &&
    snAppData !== null &&
    (snAppData as { locked?: unknown }).locked === true;
  return {
    uuid: item.uuid,
    title: content.title ?? "",
    text: content.text ?? "",
    trashed: content.trashed === true,
    protected: content.protected === true,
    locked,
    noteType: (content.noteType as NoteType | undefined) ?? "plain-text",
    createdAt: item.created_at ?? "",
    updatedAt: item.updated_at ?? "",
    created_at_timestamp: item.created_at_timestamp ?? 0,
    updated_at_timestamp: item.updated_at_timestamp ?? 0,
  };
}

export interface EncryptedNotePayload {
  content: string;
  enc_item_key: string;
  items_key_id: string;
}

export async function encryptNote(
  note: {
    uuid: string;
    title: string;
    text: string;
    trashed?: boolean;
    noteType?: NoteType;
  },
  itemsKey: { uuid: string; itemsKey: Uint8Array },
): Promise<EncryptedNotePayload> {
  const perItemKey = await generateItemsKeyRaw();
  // AAD for items-key-encrypted payloads MUST be {u, v} only.
  // `kp` is reserved for root-key-encrypted payloads (items_keys themselves).
  // Including it here causes the SN app to fail AEAD verification and drop the note.
  const aad = { u: note.uuid, v: "004" };

  const resolvedType = note.noteType ?? "plain-text";
  // Editor identifier is a hint for legacy SN clients that route by editor
  // rather than by `noteType`. Modern SN routes by `noteType` alone, so we
  // only set this for editors with a stable, well-known identifier. For
  // `rich-text` / `task` / `spreadsheet` / `authentication` we omit it
  // intentionally — `noteType` is sufficient and a wrong identifier would
  // mask the type.
  const editorIdentifier = EDITOR_IDENTIFIERS[resolvedType];
  const previewPlain =
    resolvedType === "plain-text" || resolvedType === "markdown"
      ? note.text.slice(0, 160)
      : undefined;
  const contentObj: Record<string, unknown> = {
    text: note.text,
    title: note.title,
    noteType: resolvedType,
    references: [],
    appData: {
      [SN_APP_DOMAIN]: {
        client_updated_at: new Date().toISOString(),
      },
    },
  };
  if (editorIdentifier) contentObj.editorIdentifier = editorIdentifier;
  if (previewPlain !== undefined) contentObj.preview_plain = previewPlain;
  if (note.trashed) contentObj.trashed = true;
  const contentJson = JSON.stringify(contentObj);

  const content = await encryptString(contentJson, perItemKey, aad);
  const enc_item_key = await encryptString(
    await toHex(perItemKey),
    itemsKey.itemsKey,
    aad,
  );

  return {
    content,
    enc_item_key,
    items_key_id: itemsKey.uuid,
  };
}

export interface TagReference {
  uuid: string;
  content_type: string;
}

export interface DecryptedTag {
  uuid: string;
  title: string;
  references: TagReference[];
  createdAt: string;
  updatedAt: string;
  updated_at_timestamp: number;
  created_at_timestamp: number;
}

export async function decryptTag(
  item: EncryptedItemInput,
  itemsKeyByUuid: Map<string, Uint8Array>,
): Promise<DecryptedTag> {
  const keyId = item.items_key_id;
  if (!keyId) {
    throw new Error(`Tag ${item.uuid} has no items_key_id`);
  }
  const itemsKey = itemsKeyByUuid.get(keyId);
  if (!itemsKey) {
    throw new Error(`Unknown items_key ${keyId} for tag ${item.uuid}`);
  }
  const itemKeyHex = await decryptString(
    item.enc_item_key,
    itemsKey,
    item.uuid,
  );
  const perItemKey = await fromHex(itemKeyHex);
  const contentJson = await decryptString(
    item.content,
    perItemKey,
    item.uuid,
  );
  const content = parseDecryptedContent<{
    title?: string;
    references?: Array<{ uuid?: string; content_type?: string }>;
  }>(contentJson, "tag", item.uuid);
  const references: TagReference[] = Array.isArray(content.references)
    ? content.references
        .filter(
          (r): r is { uuid: string; content_type: string } =>
            typeof r?.uuid === "string" && typeof r?.content_type === "string",
        )
        .map((r) => ({ uuid: r.uuid, content_type: r.content_type }))
    : [];
  return {
    uuid: item.uuid,
    title: content.title ?? "",
    references,
    createdAt: item.created_at ?? "",
    updatedAt: item.updated_at ?? "",
    created_at_timestamp: item.created_at_timestamp ?? 0,
    updated_at_timestamp: item.updated_at_timestamp ?? 0,
  };
}

export interface EncryptedTagPayload {
  content: string;
  enc_item_key: string;
  items_key_id: string;
}

export async function encryptTag(
  tag: {
    uuid: string;
    title: string;
    references: TagReference[];
  },
  itemsKey: { uuid: string; itemsKey: Uint8Array },
): Promise<EncryptedTagPayload> {
  const perItemKey = await generateItemsKeyRaw();
  // Same AAD rule as notes: {u, v} only. `kp` would cause the official app
  // to drop the item silently (see project memory "SN 004 AAD rule").
  const aad = { u: tag.uuid, v: "004" };

  const contentObj: Record<string, unknown> = {
    title: tag.title,
    references: tag.references,
    appData: {
      [SN_APP_DOMAIN]: {
        client_updated_at: new Date().toISOString(),
      },
    },
  };
  const contentJson = JSON.stringify(contentObj);

  const content = await encryptString(contentJson, perItemKey, aad);
  const enc_item_key = await encryptString(
    await toHex(perItemKey),
    itemsKey.itemsKey,
    aad,
  );

  return {
    content,
    enc_item_key,
    items_key_id: itemsKey.uuid,
  };
}

export function normalizeSuperText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      "root" in parsed &&
      (parsed as { root?: unknown }).root &&
      typeof (parsed as { root: unknown }).root === "object" &&
      (parsed as { root: { type?: unknown } }).root.type === "root" &&
      Array.isArray((parsed as { root: { children?: unknown } }).root.children)
    ) {
      return text;
    }
  } catch {
    // fall through to wrap
  }
  return JSON.stringify({
    root: {
      children: [
        {
          children: [
            {
              detail: 0,
              format: 0,
              mode: "normal",
              style: "",
              text,
              type: "text",
              version: 1,
            },
          ],
          direction: "ltr",
          format: "",
          indent: 0,
          type: "paragraph",
          version: 1,
        },
      ],
      direction: "ltr",
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  });
}
