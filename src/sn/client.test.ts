import { afterEach, describe, expect, it, vi } from "vitest";

const {
  syncMock,
  loadSessionMock,
  saveSessionMock,
  getLoginParamsMock,
  loginMock,
} = vi.hoisted(() => ({
  syncMock: vi.fn(),
  loadSessionMock: vi.fn(),
  saveSessionMock: vi.fn(),
  getLoginParamsMock: vi.fn(),
  loginMock: vi.fn(),
}));

vi.mock("./http.js", async () => {
  const actual = await vi.importActual<typeof import("./http.js")>("./http.js");
  return {
    ...actual,
    sync: syncMock,
    getLoginParams: getLoginParamsMock,
    login: loginMock,
  };
});

vi.mock("./session.js", () => ({
  loadSession: loadSessionMock,
  saveSession: saveSessionMock,
  deleteSession: vi.fn(),
}));

import { createCipheriv, createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { SnApiError, type RawItem } from "./http.js";
import { createClientFromLogin, createClientFromSession } from "./client.js";
import { decryptNote, encryptString } from "./protocol004.js";
import { randomBytes, toHex } from "./crypto.js";

describe("createClientFromSession bootstrap", () => {
  afterEach(() => {
    syncMock.mockReset();
    loadSessionMock.mockReset();
    saveSessionMock.mockReset();
    getLoginParamsMock.mockReset();
    loginMock.mockReset();
  });

  it("ignores the stored syncToken so the cold-boot sync is full (fetches items_keys)", async () => {
    loadSessionMock.mockResolvedValue({
      serverUrl: "https://example.test",
      email: "a@b.co",
      sessionPayload: { access_token: "tok", refresh_token: "ref" },
      masterKeyHex: "00".repeat(32),
      keyParams: { version: "004", identifier: "a@b.co", pw_nonce: "n" },
      syncToken: "stale-token-from-previous-process",
      savedAt: new Date().toISOString(),
    });

    // Return at least one items_key to satisfy the bootstrap; we don't actually
    // decrypt anything here — the call will fail to decrypt the items_key (our
    // fake masterKey is all zeros) and createClientFromSession should throw.
    // What we care about is the syncToken passed to http.sync on the first call.
    syncMock.mockResolvedValue({
      retrieved_items: [],
      saved_items: [],
      conflicts: [],
      sync_token: "fresh-token",
    });

    await expect(
      createClientFromSession({
        serverUrl: "https://example.test",
        email: "a@b.co",
      }),
    ).rejects.toThrow(/No items_key decrypted/);

    expect(syncMock).toHaveBeenCalled();
    const firstCallParams = syncMock.mock.calls[0]?.[1];
    expect(firstCallParams?.syncToken).toBeUndefined();
  });
});

describe("createClientFromLogin MFA handling", () => {
  afterEach(() => {
    syncMock.mockReset();
    loadSessionMock.mockReset();
    saveSessionMock.mockReset();
    getLoginParamsMock.mockReset();
    loginMock.mockReset();
  });

  // SN verifies MFA inside the /v2/login-params handler — when 2FA is enabled,
  // the FIRST getLoginParams call comes back as 401 mfa-required. This test
  // pins down the contract: the prompt fires, the user's code goes back via
  // a second getLoginParams call with `{ [mfa_key]: code }`, and ONLY THEN do
  // we hit /v2/login. The previous 0.3.4 release wrapped the try/catch around
  // http.login instead, so the MFA error from login-params propagated straight
  // to the logger as "Login failed" without ever prompting (issue #3, Adaluin).
  it("prompts for the 2FA code on mfa-required from /v2/login-params and resubmits with mfa_<key>=code", async () => {
    let getLoginParamsCalls = 0;
    getLoginParamsMock.mockImplementation(async (_cfg, _email, _challenge, extra?: Record<string, string>) => {
      getLoginParamsCalls += 1;
      if (getLoginParamsCalls === 1) {
        // First attempt: server demands MFA.
        throw new SnApiError(
          "Please enter your two-factor authentication code.",
          "mfa-required",
          401,
          { mfa_key: "mfa_1a2b3c" },
        );
      }
      // Second attempt: the MFA code has to be in the body, under the key the
      // server gave us. Anything else means the wrong endpoint got the code.
      expect(extra).toEqual({ mfa_1a2b3c: "654321" });
      return {
        identifier: "a@b.co",
        pw_nonce: "deadbeef".repeat(8),
        version: "004",
      };
    });
    loginMock.mockResolvedValue({
      session: {
        access_token: "tok",
        refresh_token: "ref",
        access_expiration: 0,
        refresh_expiration: 0,
      },
      key_params: {
        version: "004",
        identifier: "a@b.co",
        pw_nonce: "deadbeef".repeat(8),
      },
      user: { uuid: "u-uuid", email: "a@b.co" },
    });
    syncMock.mockResolvedValue({
      retrieved_items: [],
      saved_items: [],
      conflicts: [],
      sync_token: "tok",
    });

    const mfaPrompt = vi.fn().mockResolvedValue("654321");

    await expect(
      createClientFromLogin(
        { serverUrl: "https://example.test", email: "a@b.co" },
        "correct horse battery staple",
        mfaPrompt,
      ),
    ).rejects.toThrow(/No items_key decrypted/);

    expect(mfaPrompt).toHaveBeenCalledTimes(1);
    expect(getLoginParamsMock).toHaveBeenCalledTimes(2);
    expect(loginMock).toHaveBeenCalledTimes(1);
    // Login must never see the MFA code — that's a /v2/login-params concern.
    const loginArgs = loginMock.mock.calls[0];
    expect(loginArgs).toHaveLength(4);
  });

  it("fails fast (without ever calling login) when 2FA is enabled but no mfaPrompt is provided", async () => {
    getLoginParamsMock.mockRejectedValueOnce(
      new SnApiError(
        "Please enter your two-factor authentication code.",
        "mfa-required",
        401,
        { mfa_key: "mfa_1a2b3c" },
      ),
    );

    await expect(
      createClientFromLogin(
        { serverUrl: "https://example.test", email: "a@b.co" },
        "correct horse battery staple",
      ),
    ).rejects.toThrow(/Two-factor authentication is enabled/);

    expect(loginMock).not.toHaveBeenCalled();
  });
});

describe("protected notes in read paths", () => {
  afterEach(() => {
    syncMock.mockReset();
    loadSessionMock.mockReset();
  });

  // Synthetic vault: random keys, no account or network.
  async function encryptedItem(
    uuid: string,
    contentType: string,
    content: Record<string, unknown>,
    wrappingKey: Uint8Array,
    itemsKeyId: string | null,
    timestamp = 1,
  ): Promise<RawItem> {
    const itemKey = await randomBytes(32);
    const aad = { u: uuid, v: "004" };
    return {
      uuid,
      content_type: contentType,
      content: await encryptString(JSON.stringify(content), itemKey, aad),
      enc_item_key: await encryptString(await toHex(itemKey), wrappingKey, aad),
      items_key_id: itemsKeyId,
      created_at_timestamp: timestamp,
      updated_at_timestamp: timestamp,
    } as RawItem;
  }

  async function clientWithProtectedNote() {
    const masterKey = await randomBytes(32);
    const itemsKey = await randomBytes(32);
    const keyId = "11111111-1111-4111-8111-111111111111";
    const items = [
      await encryptedItem(keyId, "SN|ItemsKey", { version: "004", itemsKey: await toHex(itemsKey) }, masterKey, null),
      await encryptedItem("22222222-2222-4222-8222-222222222222", "Note",
        { title: "Open", text: "the needle", references: [] }, itemsKey, keyId, 5),
      await encryptedItem("33333333-3333-4333-8333-333333333333", "Note",
        { title: "Vault", text: "the needle is also here", references: [], protected: true }, itemsKey, keyId, 1),
    ];
    items[2] = { ...items[2]!, updated_at_timestamp: 9 };
    loadSessionMock.mockResolvedValue({
      serverUrl: "https://example.test",
      email: "a@b.co",
      sessionPayload: { access_token: "tok", refresh_token: "ref" },
      masterKeyHex: await toHex(masterKey),
      keyParams: { version: "004", identifier: "a@b.co", pw_nonce: "n" },
      syncToken: null,
      savedAt: new Date().toISOString(),
    });
    syncMock.mockResolvedValue({ retrieved_items: items, saved_items: [], conflicts: [], sync_token: "t" });
    return createClientFromSession({ serverUrl: "https://example.test", email: "a@b.co" });
  }

  it("search does not match protected notes, whose presence in results would leak their content", async () => {
    const client = await clientWithProtectedNote();
    expect((await client.searchNotes("needle", 10)).map((n) => n.title)).toEqual(["Open"]);
    expect(await client.searchNotes("Vault", 10)).toEqual([]);
  });

  it("stats masks a protected note's title", async () => {
    const stats = await (await clientWithProtectedNote()).stats();
    expect([stats.largest?.title, stats.oldest?.title, stats.newest?.title])
      .toEqual(["[Protected]", "[Protected]", "[Protected]"]);
  });
});

describe("legacy 003 items in an account upgraded to 004", () => {
  const KEY_004 = "11111111-1111-4111-8111-111111111111";
  const KEY_003 = "55555555-5555-4555-8555-555555555555";
  const NOTE = "22222222-2222-4222-8222-222222222222";
  const TAG = "33333333-3333-4333-8333-333333333333";
  const PROTECTED = "44444444-4444-4444-8444-444444444444";
  const hex32 = () => nodeRandomBytes(32).toString("hex");

  // Test-only 003 encoder written from the published format.
  function enc003(plain: string, ek: string, ak: string, uuid: string): string {
    const iv = nodeRandomBytes(16);
    const c = createCipheriv("aes-256-cbc", Buffer.from(ek, "hex"), iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
    const mac = createHmac("sha256", Buffer.from(ak, "hex")).update(`003:${uuid}:${iv.toString("hex")}:${ct}`).digest("hex");
    return `003:${mac}:${uuid}:${iv.toString("hex")}:${ct}`;
  }

  function item003(uuid: string, contentType: string, content: object, legacy: { ek: string; ak: string }): RawItem {
    const ek = hex32(), ak = hex32();
    return {
      uuid,
      content_type: contentType,
      content: enc003(JSON.stringify(content), ek, ak, uuid),
      enc_item_key: enc003(ek + ak, legacy.ek, legacy.ak, uuid),
      items_key_id: null,
      created_at_timestamp: 1,
      updated_at_timestamp: 1,
    } as RawItem;
  }

  async function itemsKeyItem(uuid: string, masterKey: Uint8Array, body: object, ts: number): Promise<RawItem> {
    const wrap = await randomBytes(32);
    const aad = { u: uuid, v: "004", kp: { version: "004" } };
    return {
      uuid,
      content_type: "SN|ItemsKey",
      enc_item_key: await encryptString(await toHex(wrap), masterKey, aad),
      content: await encryptString(JSON.stringify(body), wrap, aad),
      items_key_id: null,
      created_at_timestamp: ts,
      updated_at_timestamp: ts,
    } as RawItem;
  }

  afterEach(() => {
    syncMock.mockReset();
    loadSessionMock.mockReset();
    saveSessionMock.mockReset();
  });

  async function setup() {
    const masterKey = await randomBytes(32);
    const itemsKey004 = await randomBytes(32);
    const legacy = { ek: hex32(), ak: hex32() };
    const server = new Map<string, RawItem>();
    for (const i of [
      await itemsKeyItem(KEY_004, masterKey, { version: "004", itemsKey: await toHex(itemsKey004) }, 5),
      // Newer than the 004 key on purpose: a 003 key must never become the default.
      await itemsKeyItem(KEY_003, masterKey, { version: "003", itemsKey: legacy.ek, dataAuthenticationKey: legacy.ak }, 9),
      item003(NOTE, "Note", { title: "Old", text: "legacy body", references: [] }, legacy),
      item003(TAG, "Tag", { title: "Archive", references: [{ uuid: NOTE, content_type: "Note" }] }, legacy),
      { ...item003(PROTECTED, "Note", { title: "Codes", text: "legacy secret", references: [], protected: true }, legacy),
        updated_at_timestamp: 7 },
    ]) server.set(i.uuid, i);
    const pushed: RawItem[] = [];
    loadSessionMock.mockResolvedValue({
      serverUrl: "https://example.test",
      email: "a@b.co",
      sessionPayload: { access_token: "tok", refresh_token: "ref" },
      masterKeyHex: await toHex(masterKey),
      keyParams: { version: "004", identifier: "a@b.co", pw_nonce: "n" },
      syncToken: null,
      savedAt: new Date().toISOString(),
    });
    saveSessionMock.mockResolvedValue(undefined);
    syncMock.mockImplementation(async (_cfg: unknown, params: { items?: RawItem[] }) => {
      const saved = (params.items ?? []).map((i) => ({ ...i, updated_at_timestamp: i.updated_at_timestamp + 1 }));
      for (const i of saved) {
        pushed.push(i);
        server.set(i.uuid, i);
      }
      return { retrieved_items: [...server.values()], saved_items: saved, conflicts: [], sync_token: "t" };
    });
    const client = await createClientFromSession({ serverUrl: "https://example.test", email: "a@b.co" });
    return { client, pushed, itemsKey004 };
  }

  it("reads 003 notes and tags without the account password", async () => {
    const { client } = await setup();
    expect(await client.getNote(NOTE)).toMatchObject({ title: "Old", text: "legacy body", tags: ["Archive"] });
    expect((await client.listTags()).map((t) => t.title)).toEqual(["Archive"]);
    expect((await client.stats()).decryptFailures).toEqual({ notes: 0, tags: 0 });
  });

  it("keeps newly readable protected 003 notes out of search and stats titles", async () => {
    const { client } = await setup();
    expect((await client.searchNotes("legacy", 10)).map((n) => n.uuid)).toEqual([NOTE]);
    expect((await client.stats()).newest).toMatchObject({ uuid: PROTECTED, title: "[Protected]" });
  });

  it("re-encrypts an edited 003 note as 004 under the 004 items key", async () => {
    const { client, pushed, itemsKey004 } = await setup();
    await client.updateNote({ uuid: NOTE, text: "edited" });
    const stored = pushed.find((i) => i.uuid === NOTE)!;
    expect(stored.content.startsWith("004:") && stored.enc_item_key.startsWith("004:")).toBe(true);
    expect(stored.items_key_id).toBe(KEY_004);
    expect(await decryptNote(stored, new Map([[KEY_004, itemsKey004]]))).toMatchObject({ title: "Old", text: "edited" });
  });

  it("never encrypts new items under a 003 key", async () => {
    const { client, pushed } = await setup();
    await client.createNote({ title: "New", text: "fresh" });
    expect(pushed.map((i) => [i.items_key_id, i.content.slice(0, 4)])).toEqual([[KEY_004, "004:"]]);
  });
});
