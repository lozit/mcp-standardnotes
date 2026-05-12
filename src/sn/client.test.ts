import { afterEach, describe, expect, it, vi } from "vitest";

const { syncMock, loadSessionMock, saveSessionMock } = vi.hoisted(() => ({
  syncMock: vi.fn(),
  loadSessionMock: vi.fn(),
  saveSessionMock: vi.fn(),
}));

vi.mock("./http.js", async () => {
  const actual = await vi.importActual<typeof import("./http.js")>("./http.js");
  return { ...actual, sync: syncMock };
});

vi.mock("./session.js", () => ({
  loadSession: loadSessionMock,
  saveSession: saveSessionMock,
  deleteSession: vi.fn(),
}));

import { createClientFromSession } from "./client.js";

describe("createClientFromSession bootstrap", () => {
  afterEach(() => {
    syncMock.mockReset();
    loadSessionMock.mockReset();
    saveSessionMock.mockReset();
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
