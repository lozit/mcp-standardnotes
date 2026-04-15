import { logger } from "../security/logger.js";
import * as http from "./http.js";
import {
  decryptItemsKey,
  decryptNote,
  deriveRootKey,
  encryptNote,
  generateItemsKeyRaw,
  normalizeSuperText,
  type DecryptedItemsKey,
  type DecryptedNote,
  type KeyParams004,
  type RootKey,
} from "./protocol004.js";
import { loadSession, saveSession, type StoredSession } from "./session.js";
import type { Note, NoteSummary, NoteType } from "./types.js";
import { fromHex, toHex } from "./crypto.js";

export interface SnClient {
  listNotes(opts: {
    limit: number;
    offset: number;
    includeTrashed: boolean;
  }): Promise<NoteSummary[]>;
  searchNotes(query: string, limit: number): Promise<NoteSummary[]>;
  getNote(uuid: string): Promise<Note | null>;
  createNote(input: {
    title: string;
    text: string;
    noteType?: NoteType;
  }): Promise<string>;
  updateNote(input: {
    uuid: string;
    title?: string;
    text?: string;
    noteType?: NoteType;
  }): Promise<void>;
  deleteNote(uuid: string, permanent: boolean): Promise<void>;
  sync(): Promise<void>;
}

export interface SnClientConfig {
  serverUrl: string;
  email: string;
}

interface ClientState {
  serverUrl: string;
  email: string;
  authToken: string;
  refreshToken: string;
  rootKey: RootKey;
  itemsKeys: Map<string, DecryptedItemsKey>;
  defaultItemsKeyUuid: string | null;
  notesCache: Map<string, DecryptedNote>;
  encryptedItemsRaw: Map<string, http.RawItem>;
  syncToken: string | null;
}

export async function createClientFromLogin(
  config: SnClientConfig,
  password: string,
  mfaPrompt?: () => Promise<string>,
): Promise<SnClient> {
  if (!password) throw new Error("password required");
  const codeVerifier = http.generateCodeVerifier();
  const codeChallenge = http.computeCodeChallenge(codeVerifier);
  const params = await http.getLoginParams(
    { serverUrl: config.serverUrl },
    config.email,
    codeChallenge,
  );
  const keyParams: KeyParams004 = {
    version: "004",
    identifier: params.identifier,
    pw_nonce: params.pw_nonce,
    origination: params.origination,
    created: params.created,
  };
  const rootKey = await deriveRootKey(password, keyParams);
  let loginRes: http.LoginResponse;
  try {
    loginRes = await http.login(
      { serverUrl: config.serverUrl },
      config.email,
      rootKey.serverPassword,
      codeVerifier,
    );
  } catch (err) {
    if (
      err instanceof http.SnApiError &&
      err.tag === "mfa-required" &&
      mfaPrompt
    ) {
      const mfaKey =
        (err.payload as { mfa_key?: string } | undefined)?.mfa_key ?? "";
      if (!mfaKey) throw err;
      const code = await mfaPrompt();
      loginRes = await http.login(
        { serverUrl: config.serverUrl },
        config.email,
        rootKey.serverPassword,
        codeVerifier,
        { mfaKey, code },
      );
    } else {
      throw err;
    }
  }

  const state: ClientState = {
    serverUrl: config.serverUrl,
    email: config.email,
    authToken: loginRes.session.access_token,
    refreshToken: loginRes.session.refresh_token,
    rootKey,
    itemsKeys: new Map(),
    defaultItemsKeyUuid: null,
    notesCache: new Map(),
    encryptedItemsRaw: new Map(),
    syncToken: null,
  };

  await saveSession(config.email, {
    serverUrl: config.serverUrl,
    email: config.email,
    sessionPayload: {
      access_token: loginRes.session.access_token,
      refresh_token: loginRes.session.refresh_token,
    },
    masterKeyHex: await toHex(rootKey.masterKey),
    keyParams: loginRes.key_params ?? keyParams,
    savedAt: new Date().toISOString(),
  });

  await fullSync(state);
  return buildClient(state);
}

export async function createClientFromSession(
  config: SnClientConfig,
): Promise<SnClient> {
  const stored = await loadSession(config.email);
  if (!stored) {
    throw new Error(
      "No session found. Run `npm run login` to authenticate first.",
    );
  }
  if (!stored.masterKeyHex || !/^[0-9a-f]{64}$/i.test(stored.masterKeyHex)) {
    throw new Error(
      "Stored session is missing a valid masterKey; run `npm run login` again.",
    );
  }
  const keyParams = stored.keyParams as KeyParams004;
  const rootKey: RootKey = {
    masterKey: await fromHex(stored.masterKeyHex),
    serverPassword: "",
    keyParams,
  };
  const state: ClientState = {
    serverUrl: stored.serverUrl,
    email: stored.email,
    authToken: stored.sessionPayload.access_token,
    refreshToken: stored.sessionPayload.refresh_token,
    rootKey,
    itemsKeys: new Map(),
    defaultItemsKeyUuid: null,
    notesCache: new Map(),
    encryptedItemsRaw: new Map(),
    syncToken: null,
  };
  await fullSync(state);
  return buildClient(state);
}

async function fullSync(state: ClientState): Promise<void> {
  let cursorToken: string | undefined;
  let syncToken: string | undefined = state.syncToken ?? undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await http.sync(
      { serverUrl: state.serverUrl, authToken: state.authToken },
      { syncToken, cursorToken, limit: 150 },
    );
    for (const item of res.retrieved_items) {
      if (item.deleted) continue;
      state.encryptedItemsRaw.set(item.uuid, item);
    }
    syncToken = res.sync_token;
    cursorToken = res.cursor_token;
    if (!cursorToken) break;
  }
  state.syncToken = syncToken ?? null;

  // First pass: decrypt items_keys
  for (const item of state.encryptedItemsRaw.values()) {
    if (item.content_type !== "SN|ItemsKey") continue;
    try {
      const k = await decryptItemsKey(item, state.rootKey);
      state.itemsKeys.set(k.uuid, k);
      if (!state.defaultItemsKeyUuid) state.defaultItemsKeyUuid = k.uuid;
    } catch (err) {
      logger.warn(`Failed to decrypt items_key ${item.uuid}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (state.itemsKeys.size === 0) {
    throw new Error(
      "No items_key decrypted — likely wrong password or account not on protocol 004.",
    );
  }

  const itemsKeyBytesByUuid = new Map<string, Uint8Array>();
  for (const [u, k] of state.itemsKeys.entries()) {
    itemsKeyBytesByUuid.set(u, k.itemsKey);
  }

  // Second pass: decrypt notes
  for (const item of state.encryptedItemsRaw.values()) {
    if (item.content_type !== "Note") continue;
    try {
      const note = await decryptNote(item, itemsKeyBytesByUuid);
      state.notesCache.set(note.uuid, note);
    } catch (err) {
      logger.warn(`Failed to decrypt note ${item.uuid}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info("Sync complete", {
    notes: state.notesCache.size,
    itemsKeys: state.itemsKeys.size,
  });
}

function toSummary(n: DecryptedNote): NoteSummary {
  return {
    uuid: n.uuid,
    title: n.title,
    updatedAt: n.updatedAt,
    preview: n.text.slice(0, 200),
    trashed: n.trashed,
    noteType: n.noteType,
  };
}

function toFullNote(n: DecryptedNote): Note {
  return {
    uuid: n.uuid,
    title: n.title,
    text: n.text,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    trashed: n.trashed,
    tags: [],
    noteType: n.noteType,
  };
}

function buildClient(state: ClientState): SnClient {
  const defaultItemsKey = (): DecryptedItemsKey => {
    const uuid = state.defaultItemsKeyUuid;
    if (!uuid) throw new Error("No default items_key available");
    const k = state.itemsKeys.get(uuid);
    if (!k) throw new Error(`Default items_key ${uuid} missing from state`);
    return k;
  };

  const pushItems = async (items: unknown[]): Promise<http.SyncResponse> => {
    const res = await http.sync(
      { serverUrl: state.serverUrl, authToken: state.authToken },
      { syncToken: state.syncToken ?? undefined, items, limit: 150 },
    );
    for (const saved of res.saved_items) {
      state.encryptedItemsRaw.set(saved.uuid, saved);
    }
    state.syncToken = res.sync_token ?? state.syncToken;
    return res;
  };

  return {
    async listNotes({ limit, offset, includeTrashed }) {
      const all = [...state.notesCache.values()]
        .filter((n) => includeTrashed || !n.trashed)
        .sort((a, b) => b.updated_at_timestamp - a.updated_at_timestamp);
      return all.slice(offset, offset + limit).map(toSummary);
    },

    async searchNotes(query, limit) {
      const q = query.toLowerCase();
      const hits: DecryptedNote[] = [];
      for (const n of state.notesCache.values()) {
        if (n.trashed) continue;
        if (n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q)) {
          hits.push(n);
          if (hits.length >= limit * 4) break;
        }
      }
      return hits
        .sort((a, b) => b.updated_at_timestamp - a.updated_at_timestamp)
        .slice(0, limit)
        .map(toSummary);
    },

    async getNote(uuid) {
      const n = state.notesCache.get(uuid);
      return n ? toFullNote(n) : null;
    },

    async createNote({ title, text, noteType }) {
      const uuid = crypto.randomUUID();
      const resolvedType: NoteType = noteType ?? "markdown";
      const resolvedText =
        resolvedType === "super" ? normalizeSuperText(text) : text;
      const encrypted = await encryptNote(
        {
          uuid,
          title,
          text: resolvedText,
          trashed: false,
          noteType: resolvedType,
        },
        { uuid: defaultItemsKey().uuid, itemsKey: defaultItemsKey().itemsKey },
      );
      const nowIso = new Date().toISOString();
      const res = await pushItems([
        {
          uuid,
          content_type: "Note",
          content: encrypted.content,
          enc_item_key: encrypted.enc_item_key,
          items_key_id: encrypted.items_key_id,
          created_at: nowIso,
          updated_at: nowIso,
          created_at_timestamp: 0,
          updated_at_timestamp: 0,
          deleted: false,
        },
      ]);
      const saved = res.saved_items.find((i) => i.uuid === uuid);
      if (!saved) {
        const conflict = res.conflicts.find(
          (c) => (c as { unsaved_item?: { uuid?: string } }).unsaved_item?.uuid === uuid,
        );
        throw new Error(
          `Server did not save note ${uuid}` +
            (conflict ? ` (conflict: ${JSON.stringify(conflict)})` : ""),
        );
      }
      state.notesCache.set(uuid, {
        uuid,
        title,
        text: resolvedText,
        trashed: false,
        noteType: resolvedType,
        createdAt: saved.created_at ?? nowIso,
        updatedAt: saved.updated_at ?? nowIso,
        created_at_timestamp: saved.created_at_timestamp ?? 0,
        updated_at_timestamp: saved.updated_at_timestamp ?? 0,
      });
      return uuid;
    },

    async updateNote({ uuid, title, text, noteType }) {
      const existing = state.notesCache.get(uuid);
      if (!existing) throw new Error(`Note ${uuid} not found`);
      const raw = state.encryptedItemsRaw.get(uuid);
      if (!raw) throw new Error(`Note ${uuid} has no encrypted record`);
      const nextType: NoteType = noteType ?? existing.noteType;
      const nextTextRaw = text ?? existing.text;
      const nextText =
        nextType === "super" && text !== undefined
          ? normalizeSuperText(text)
          : nextTextRaw;
      const merged = {
        uuid,
        title: title ?? existing.title,
        text: nextText,
        trashed: existing.trashed,
        noteType: nextType,
      };
      const encrypted = await encryptNote(merged, {
        uuid: defaultItemsKey().uuid,
        itemsKey: defaultItemsKey().itemsKey,
      });
      const res = await pushItems([
        {
          ...raw,
          content: encrypted.content,
          enc_item_key: encrypted.enc_item_key,
          items_key_id: encrypted.items_key_id,
          updated_at: new Date().toISOString(),
          updated_at_timestamp: raw.updated_at_timestamp,
        },
      ]);
      const saved = res.saved_items.find((i) => i.uuid === uuid);
      if (!saved) {
        const conflict = res.conflicts.find(
          (c) => (c as { unsaved_item?: { uuid?: string } }).unsaved_item?.uuid === uuid,
        );
        throw new Error(
          `Server did not save note ${uuid}` +
            (conflict ? ` (conflict: ${JSON.stringify(conflict)})` : ""),
        );
      }
      state.notesCache.set(uuid, {
        ...existing,
        ...merged,
        createdAt: saved.created_at ?? existing.createdAt,
        updatedAt: saved.updated_at ?? existing.updatedAt,
        created_at_timestamp:
          saved.created_at_timestamp ?? existing.created_at_timestamp,
        updated_at_timestamp:
          saved.updated_at_timestamp ?? existing.updated_at_timestamp,
      });
    },

    async deleteNote(uuid, permanent) {
      const raw = state.encryptedItemsRaw.get(uuid);
      if (!raw) throw new Error(`Note ${uuid} not found`);
      if (permanent) {
        await pushItems([
          {
            uuid,
            content_type: "Note",
            deleted: true,
            content: "",
            enc_item_key: "",
            updated_at_timestamp: raw.updated_at_timestamp,
          },
        ]);
        state.notesCache.delete(uuid);
        state.encryptedItemsRaw.delete(uuid);
      } else {
        const existing = state.notesCache.get(uuid);
        if (!existing) throw new Error(`Note ${uuid} not found in cache`);
        const merged = { ...existing, trashed: true };
        const encrypted = await encryptNote(
          {
            uuid,
            title: merged.title,
            text: merged.text,
            trashed: true,
            noteType: merged.noteType,
          },
          {
            uuid: defaultItemsKey().uuid,
            itemsKey: defaultItemsKey().itemsKey,
          },
        );
        await pushItems([
          {
            ...raw,
            content: encrypted.content,
            enc_item_key: encrypted.enc_item_key,
            items_key_id: encrypted.items_key_id,
            updated_at: new Date().toISOString(),
            updated_at_timestamp: raw.updated_at_timestamp,
          },
        ]);
        state.notesCache.set(uuid, merged);
      }
    },

    async sync() {
      await fullSync(state);
    },
  };
}

// Keep unused imports from triggering errors while some helpers are reserved
// for future session-resume or rotation work.
void generateItemsKeyRaw;
export type { StoredSession };
