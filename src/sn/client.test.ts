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

import { SnApiError, type RawItem } from "./http.js";
import { createClientFromLogin, createClientFromSession } from "./client.js";
import { encryptString } from "./protocol004.js";
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
