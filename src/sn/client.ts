import { logger } from "../security/logger.js";
import * as http from "./http.js";
import {
  decryptItemsKey,
  decryptNote,
  decryptTag,
  deriveRootKey,
  encryptNote,
  encryptTag,
  generateItemsKeyRaw,
  normalizeSuperText,
  type DecryptedItemsKey,
  type DecryptedNote,
  type DecryptedTag,
  type KeyParams004,
  type RootKey,
  type TagReference,
} from "./protocol004.js";
import { loadSession, saveSession, type StoredSession } from "./session.js";
import type {
  Note,
  NoteSummary,
  NoteType,
  Tag,
  TagSummary,
  VaultStats,
} from "./types.js";
import { fromHex, toHex } from "./crypto.js";

export interface SnClient {
  listNotes(opts: {
    limit: number;
    offset: number;
    includeTrashed: boolean;
    tag?: string;
  }): Promise<NoteSummary[]>;
  stats(): Promise<VaultStats>;
  searchNotes(query: string, limit: number): Promise<NoteSummary[]>;
  getNote(uuid: string): Promise<Note | null>;
  createNote(input: {
    title: string;
    text: string;
    noteType?: NoteType;
    tags?: string[];
  }): Promise<string>;
  createNotesBatch(
    inputs: Array<{
      title: string;
      text: string;
      noteType?: NoteType;
      tags?: string[];
    }>,
  ): Promise<Array<{ uuid: string; title: string }>>;
  updateNote(input: {
    uuid: string;
    title?: string;
    text?: string;
    noteType?: NoteType;
    tags?: string[];
  }): Promise<void>;
  deleteNote(uuid: string, permanent: boolean): Promise<void>;
  listTags(): Promise<TagSummary[]>;
  getTag(uuid: string): Promise<Tag | null>;
  createTag(input: { title: string }): Promise<string>;
  updateTag(input: { uuid: string; title: string }): Promise<void>;
  deleteTag(uuid: string): Promise<void>;
  attachTag(noteUuid: string, tagUuid: string): Promise<void>;
  detachTag(noteUuid: string, tagUuid: string): Promise<void>;
  sync(): Promise<{ notes: number; tags: number; syncedAt: string }>;
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
  tagsCache: Map<string, DecryptedTag>;
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
    if (!(err instanceof http.SnApiError) || err.tag !== "mfa-required") {
      throw err;
    }
    if (!mfaPrompt) {
      throw new Error(
        "Two-factor authentication is enabled on this account. " +
          "Run `npm run login` interactively (it wires the MFA prompt).",
      );
    }
    const mfaKey =
      (err.payload as { mfa_key?: string } | undefined)?.mfa_key ?? "";
    if (!mfaKey) {
      throw new Error(
        "Server requested 2FA but did not return an mfa_key field. " +
          "This is likely a server bug or a non-standard MFA flow.",
      );
    }
    const code = (await mfaPrompt()).trim();
    if (!code) {
      throw new Error("Empty 2FA code; aborting login.");
    }
    loginRes = await http.login(
      { serverUrl: config.serverUrl },
      config.email,
      rootKey.serverPassword,
      codeVerifier,
      { mfaKey, code },
    );
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
    tagsCache: new Map(),
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
    tagsCache: new Map(),
    encryptedItemsRaw: new Map(),
    syncToken: null, // fix: full sync on startup to get items_key
  };
  await fullSync(state);
  return buildClient(state);
}

async function persistSession(state: ClientState): Promise<void> {
  await saveSession(state.email, {
    serverUrl: state.serverUrl,
    email: state.email,
    sessionPayload: {
      access_token: state.authToken,
      refresh_token: state.refreshToken,
    },
    masterKeyHex: await toHex(state.rootKey.masterKey),
    keyParams: state.rootKey.keyParams,
    syncToken: state.syncToken,
    savedAt: new Date().toISOString(),
  });
}

async function callSync(
  state: ClientState,
  params: Parameters<typeof http.sync>[1],
): Promise<http.SyncResponse> {
  try {
    return await http.sync(
      { serverUrl: state.serverUrl, authToken: state.authToken },
      params,
    );
  } catch (err) {
    if (
      !(err instanceof http.SnApiError) ||
      err.status !== 401 ||
      !state.refreshToken
    ) {
      throw err;
    }
    logger.info("Access token rejected (401); refreshing");
    let fresh: http.SessionTokens;
    try {
      fresh = await http.refreshSession(
        { serverUrl: state.serverUrl },
        state.authToken,
        state.refreshToken,
      );
    } catch (refreshErr) {
      throw new Error(
        "Session refresh failed; run `npm run login` to re-authenticate. " +
          (refreshErr instanceof Error ? refreshErr.message : String(refreshErr)),
      );
    }
    state.authToken = fresh.access_token;
    state.refreshToken = fresh.refresh_token;
    await persistSession(state);
    return await http.sync(
      { serverUrl: state.serverUrl, authToken: state.authToken },
      params,
    );
  }
}

async function fullSync(state: ClientState): Promise<void> {
  let cursorToken: string | undefined;
  let syncToken: string | undefined = state.syncToken ?? undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await callSync(state, { syncToken, cursorToken, limit: 150 });
    for (const item of res.retrieved_items) {
      if (item.deleted) {
        state.encryptedItemsRaw.delete(item.uuid);
        state.notesCache.delete(item.uuid);
        state.tagsCache.delete(item.uuid);
        state.itemsKeys.delete(item.uuid);
        continue;
      }
      state.encryptedItemsRaw.set(item.uuid, item);
    }
    syncToken = res.sync_token;
    cursorToken = res.cursor_token;
    if (!cursorToken) break;
  }
  state.syncToken = syncToken ?? null;

  // First pass: decrypt items_keys
  let mostRecentTs = -Infinity;
  for (const item of state.encryptedItemsRaw.values()) {
    if (item.content_type !== "SN|ItemsKey") continue;
    try {
      const k = await decryptItemsKey(item, state.rootKey);
      state.itemsKeys.set(k.uuid, k);
      const ts = item.updated_at_timestamp ?? 0;
      if (ts >= mostRecentTs) {
        mostRecentTs = ts;
        state.defaultItemsKeyUuid = k.uuid;
      }
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

  // Third pass: decrypt tags
  for (const item of state.encryptedItemsRaw.values()) {
    if (item.content_type !== "Tag") continue;
    try {
      const tag = await decryptTag(item, itemsKeyBytesByUuid);
      state.tagsCache.set(tag.uuid, tag);
    } catch (err) {
      logger.warn(`Failed to decrypt tag ${item.uuid}`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("Sync complete", {
    notes: state.notesCache.size,
    tags: state.tagsCache.size,
    itemsKeys: state.itemsKeys.size,
  });

  try {
    await persistSession(state);
  } catch (err) {
    logger.warn("Failed to persist sync_token to keychain", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function toSummary(n: DecryptedNote): NoteSummary {
  return {
    uuid: n.uuid,
    title: n.title,
    updatedAt: n.updatedAt,
    preview: n.text.slice(0, 200),
    trashed: n.trashed,
    protected: n.protected,
    locked: n.locked,
    noteType: n.noteType,
  };
}

function tagsForNote(
  noteUuid: string,
  tagsCache: Map<string, DecryptedTag>,
): string[] {
  const titles: string[] = [];
  for (const tag of tagsCache.values()) {
    if (tag.references.some((r) => r.uuid === noteUuid)) {
      titles.push(tag.title);
    }
  }
  return titles.sort((a, b) => a.localeCompare(b));
}

function toFullNote(
  n: DecryptedNote,
  tagsCache: Map<string, DecryptedTag>,
): Note {
  return {
    uuid: n.uuid,
    title: n.title,
    text: n.text,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    trashed: n.trashed,
    protected: n.protected,
    locked: n.locked,
    tags: tagsForNote(n.uuid, tagsCache),
    noteType: n.noteType,
  };
}

function toTagSummary(t: DecryptedTag): TagSummary {
  return {
    uuid: t.uuid,
    title: t.title,
    updatedAt: t.updatedAt,
    noteCount: t.references.filter((r) => r.content_type === "Note").length,
  };
}

function toFullTag(t: DecryptedTag): Tag {
  return {
    uuid: t.uuid,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    noteUuids: t.references
      .filter((r) => r.content_type === "Note")
      .map((r) => r.uuid),
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
    const res = await callSync(state, {
      syncToken: state.syncToken ?? undefined,
      items,
      limit: 150,
    });
    for (const saved of res.saved_items) {
      state.encryptedItemsRaw.set(saved.uuid, saved);
    }
    state.syncToken = res.sync_token ?? state.syncToken;
    return res;
  };

  const submitNoteUpdate = async (
    uuid: string,
    merged: {
      uuid: string;
      title: string;
      text: string;
      trashed: boolean;
      noteType: NoteType;
    },
    attempt: number,
  ): Promise<http.RawItem> => {
    const raw = state.encryptedItemsRaw.get(uuid);
    if (!raw) throw new Error(`Note ${uuid} has no encrypted record`);
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
    if (saved) return saved;

    const conflict = res.conflicts.find((c) => {
      const cc = c as {
        server_item?: { uuid?: string };
        unsaved_item?: { uuid?: string };
      };
      return (
        cc.server_item?.uuid === uuid || cc.unsaved_item?.uuid === uuid
      );
    });
    if (!conflict) {
      throw new Error(
        `Server did not save note ${uuid} and reported no conflict`,
      );
    }
    const cc = conflict as {
      type?: string;
      server_item?: http.RawItem;
    };
    if (cc.type === "sync_conflict" && cc.server_item && attempt < 1) {
      logger.info(`sync_conflict on note ${uuid} — refreshing and retrying`);
      state.encryptedItemsRaw.set(uuid, cc.server_item);
      return submitNoteUpdate(uuid, merged, attempt + 1);
    }
    throw new Error(
      `Conflict on note ${uuid} (type=${cc.type ?? "unknown"}, attempts=${
        attempt + 1
      }). Run the sync tool and retry.`,
    );
  };

  const pushTag = async (
    existing: DecryptedTag | null,
    next: { uuid: string; title: string; references: TagReference[] },
  ): Promise<DecryptedTag> => {
    const raw = state.encryptedItemsRaw.get(next.uuid);
    const encrypted = await encryptTag(next, {
      uuid: defaultItemsKey().uuid,
      itemsKey: defaultItemsKey().itemsKey,
    });
    const nowIso = new Date().toISOString();
    const item = raw
      ? {
          ...raw,
          content: encrypted.content,
          enc_item_key: encrypted.enc_item_key,
          items_key_id: encrypted.items_key_id,
          updated_at: nowIso,
          updated_at_timestamp: raw.updated_at_timestamp,
        }
      : {
          uuid: next.uuid,
          content_type: "Tag",
          content: encrypted.content,
          enc_item_key: encrypted.enc_item_key,
          items_key_id: encrypted.items_key_id,
          created_at: nowIso,
          updated_at: nowIso,
          created_at_timestamp: 0,
          updated_at_timestamp: 0,
          deleted: false,
        };
    const res = await pushItems([item]);
    const saved = res.saved_items.find((i) => i.uuid === next.uuid);
    if (!saved) {
      const conflict = res.conflicts.find(
        (c) =>
          (c as { unsaved_item?: { uuid?: string } }).unsaved_item?.uuid ===
          next.uuid,
      );
      throw new Error(
        `Server did not save tag ${next.uuid}` +
          (conflict ? ` (conflict: ${JSON.stringify(conflict)})` : ""),
      );
    }
    const stored: DecryptedTag = {
      uuid: next.uuid,
      title: next.title,
      references: next.references,
      createdAt: saved.created_at ?? existing?.createdAt ?? nowIso,
      updatedAt: saved.updated_at ?? nowIso,
      created_at_timestamp:
        saved.created_at_timestamp ?? existing?.created_at_timestamp ?? 0,
      updated_at_timestamp:
        saved.updated_at_timestamp ?? existing?.updated_at_timestamp ?? 0,
    };
    state.tagsCache.set(next.uuid, stored);
    return stored;
  };

  const attachTagInternal = async (
    noteUuid: string,
    tagUuid: string,
  ): Promise<void> => {
    if (!state.notesCache.has(noteUuid)) {
      throw new Error(`Note ${noteUuid} not found`);
    }
    const tag = state.tagsCache.get(tagUuid);
    if (!tag) throw new Error(`Tag ${tagUuid} not found`);
    if (tag.references.some((r) => r.uuid === noteUuid)) return;
    const nextRefs: TagReference[] = [
      ...tag.references,
      { uuid: noteUuid, content_type: "Note" },
    ];
    await pushTag(tag, { uuid: tag.uuid, title: tag.title, references: nextRefs });
  };

  const detachTagInternal = async (
    noteUuid: string,
    tagUuid: string,
  ): Promise<void> => {
    const tag = state.tagsCache.get(tagUuid);
    if (!tag) throw new Error(`Tag ${tagUuid} not found`);
    if (!tag.references.some((r) => r.uuid === noteUuid)) return;
    const nextRefs = tag.references.filter((r) => r.uuid !== noteUuid);
    await pushTag(tag, { uuid: tag.uuid, title: tag.title, references: nextRefs });
  };

  const syncTagsToNote = async (
    noteUuid: string,
    tagUuids: string[],
  ): Promise<void> => {
    const desired = new Set(tagUuids);
    for (const uuid of desired) {
      if (!state.tagsCache.has(uuid)) {
        throw new Error(`Tag ${uuid} not found`);
      }
    }
    for (const tag of state.tagsCache.values()) {
      const hasRef = tag.references.some((r) => r.uuid === noteUuid);
      if (desired.has(tag.uuid) && !hasRef) {
        await attachTagInternal(noteUuid, tag.uuid);
      } else if (!desired.has(tag.uuid) && hasRef) {
        await detachTagInternal(noteUuid, tag.uuid);
      }
    }
  };

  return {
    async listNotes({ limit, offset, includeTrashed, tag }) {
      let allowedNoteUuids: Set<string> | null = null;
      if (tag !== undefined && tag !== "") {
        const matched =
          state.tagsCache.get(tag) ??
          [...state.tagsCache.values()].find(
            (t) => t.title.toLowerCase() === tag.toLowerCase(),
          );
        if (!matched) {
          throw new Error(`Tag not found: ${tag}`);
        }
        allowedNoteUuids = new Set(
          matched.references
            .filter((r) => r.content_type === "Note")
            .map((r) => r.uuid),
        );
      }
      const all = [...state.notesCache.values()]
        .filter((n) => includeTrashed || !n.trashed)
        .filter((n) => !allowedNoteUuids || allowedNoteUuids.has(n.uuid))
        .sort((a, b) => b.updated_at_timestamp - a.updated_at_timestamp);
      return all.slice(offset, offset + limit).map(toSummary);
    },

    async stats() {
      const notes = [...state.notesCache.values()];
      const active = notes.filter((n) => !n.trashed);
      const byNoteType: Record<string, number> = {};
      let totalTextBytes = 0;
      let largest: VaultStats["largest"] = null;
      let oldestTs = Infinity;
      let oldest: VaultStats["oldest"] = null;
      let newestTs = -Infinity;
      let newest: VaultStats["newest"] = null;
      for (const n of active) {
        byNoteType[n.noteType] = (byNoteType[n.noteType] ?? 0) + 1;
        const bytes = Buffer.byteLength(n.text, "utf8");
        totalTextBytes += bytes;
        if (!largest || bytes > largest.bytes) {
          largest = { uuid: n.uuid, title: n.title, bytes };
        }
        if (n.created_at_timestamp > 0 && n.created_at_timestamp < oldestTs) {
          oldestTs = n.created_at_timestamp;
          oldest = { uuid: n.uuid, title: n.title, createdAt: n.createdAt };
        }
        if (n.updated_at_timestamp > newestTs) {
          newestTs = n.updated_at_timestamp;
          newest = { uuid: n.uuid, title: n.title, updatedAt: n.updatedAt };
        }
      }
      return {
        notes: {
          total: notes.length,
          active: active.length,
          trashed: notes.length - active.length,
        },
        tags: state.tagsCache.size,
        byNoteType,
        totalTextBytes,
        averageTextBytes:
          active.length === 0 ? 0 : Math.round(totalTextBytes / active.length),
        largest,
        oldest,
        newest,
      };
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
      return n ? toFullNote(n, state.tagsCache) : null;
    },

    async createNote({ title, text, noteType, tags }) {
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
        protected: false,
        locked: false,
        noteType: resolvedType,
        createdAt: saved.created_at ?? nowIso,
        updatedAt: saved.updated_at ?? nowIso,
        created_at_timestamp: saved.created_at_timestamp ?? 0,
        updated_at_timestamp: saved.updated_at_timestamp ?? 0,
      });
      if (tags && tags.length > 0) {
        for (const tagUuid of tags) {
          await attachTagInternal(uuid, tagUuid);
        }
      }
      return uuid;
    },

    async createNotesBatch(inputs) {
      if (inputs.length === 0) return [];
      const nowIso = new Date().toISOString();
      type Prepared = {
        uuid: string;
        title: string;
        text: string;
        noteType: NoteType;
        tags: string[];
      };
      const prepared: Prepared[] = inputs.map((input) => {
        const resolvedType: NoteType = input.noteType ?? "markdown";
        const resolvedText =
          resolvedType === "super"
            ? normalizeSuperText(input.text)
            : input.text;
        return {
          uuid: crypto.randomUUID(),
          title: input.title,
          text: resolvedText,
          noteType: resolvedType,
          tags: input.tags ?? [],
        };
      });
      const items = await Promise.all(
        prepared.map(async (p) => {
          const encrypted = await encryptNote(
            {
              uuid: p.uuid,
              title: p.title,
              text: p.text,
              trashed: false,
              noteType: p.noteType,
            },
            {
              uuid: defaultItemsKey().uuid,
              itemsKey: defaultItemsKey().itemsKey,
            },
          );
          return {
            uuid: p.uuid,
            content_type: "Note",
            content: encrypted.content,
            enc_item_key: encrypted.enc_item_key,
            items_key_id: encrypted.items_key_id,
            created_at: nowIso,
            updated_at: nowIso,
            created_at_timestamp: 0,
            updated_at_timestamp: 0,
            deleted: false,
          };
        }),
      );
      const res = await pushItems(items);
      const savedByUuid = new Map(res.saved_items.map((i) => [i.uuid, i]));
      const failed: string[] = [];
      for (const p of prepared) {
        const saved = savedByUuid.get(p.uuid);
        if (!saved) {
          failed.push(p.uuid);
          continue;
        }
        state.notesCache.set(p.uuid, {
          uuid: p.uuid,
          title: p.title,
          text: p.text,
          trashed: false,
          protected: false,
          locked: false,
          noteType: p.noteType,
          createdAt: saved.created_at ?? nowIso,
          updatedAt: saved.updated_at ?? nowIso,
          created_at_timestamp: saved.created_at_timestamp ?? 0,
          updated_at_timestamp: saved.updated_at_timestamp ?? 0,
        });
      }
      if (failed.length > 0) {
        throw new Error(
          `Server did not save ${failed.length} note(s) in batch: ${failed.join(", ")}`,
        );
      }
      for (const p of prepared) {
        for (const tagUuid of p.tags) {
          await attachTagInternal(p.uuid, tagUuid);
        }
      }
      return prepared.map((p) => ({ uuid: p.uuid, title: p.title }));
    },

    async updateNote({ uuid, title, text, noteType, tags }) {
      const existing = state.notesCache.get(uuid);
      if (!existing) throw new Error(`Note ${uuid} not found`);
      const raw = state.encryptedItemsRaw.get(uuid);
      if (!raw) throw new Error(`Note ${uuid} has no encrypted record`);
      const contentChanged =
        title !== undefined || text !== undefined || noteType !== undefined;
      if (contentChanged) {
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
        const saved = await submitNoteUpdate(uuid, merged, 0);
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
      }
      if (tags !== undefined) {
        await syncTagsToNote(uuid, tags);
      }
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
        state.notesCache.set(uuid, {
          ...merged,
          updatedAt: saved?.updated_at ?? existing.updatedAt,
          updated_at_timestamp:
            saved?.updated_at_timestamp ?? existing.updated_at_timestamp,
        });
      }
    },

    async listTags() {
      return [...state.tagsCache.values()]
        .sort((a, b) => a.title.localeCompare(b.title))
        .map(toTagSummary);
    },

    async getTag(uuid) {
      const t = state.tagsCache.get(uuid);
      return t ? toFullTag(t) : null;
    },

    async createTag({ title }) {
      const existing = [...state.tagsCache.values()].find(
        (t) => t.title === title,
      );
      if (existing) {
        throw new Error(
          `Tag with title "${title}" already exists (uuid=${existing.uuid})`,
        );
      }
      const uuid = crypto.randomUUID();
      await pushTag(null, { uuid, title, references: [] });
      return uuid;
    },

    async updateTag({ uuid, title }) {
      const existing = state.tagsCache.get(uuid);
      if (!existing) throw new Error(`Tag ${uuid} not found`);
      await pushTag(existing, {
        uuid,
        title,
        references: existing.references,
      });
    },

    async deleteTag(uuid) {
      const raw = state.encryptedItemsRaw.get(uuid);
      if (!raw) throw new Error(`Tag ${uuid} not found`);
      await pushItems([
        {
          uuid,
          content_type: "Tag",
          deleted: true,
          content: "",
          enc_item_key: "",
          updated_at_timestamp: raw.updated_at_timestamp,
        },
      ]);
      state.tagsCache.delete(uuid);
      state.encryptedItemsRaw.delete(uuid);
    },

    async attachTag(noteUuid, tagUuid) {
      await attachTagInternal(noteUuid, tagUuid);
    },

    async detachTag(noteUuid, tagUuid) {
      await detachTagInternal(noteUuid, tagUuid);
    },

    async sync() {
      await fullSync(state);
      return {
        notes: state.notesCache.size,
        tags: state.tagsCache.size,
        syncedAt: new Date().toISOString(),
      };
    },
  };
}

// Keep unused imports from triggering errors while some helpers are reserved
// for future session-resume or rotation work.
void generateItemsKeyRaw;
export type { StoredSession };

