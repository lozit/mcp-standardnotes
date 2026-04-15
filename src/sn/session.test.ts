import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("keytar", () => ({
  default: {
    setPassword: vi.fn(async (_s: string, a: string, p: string) => {
      store.set(a, p);
    }),
    getPassword: vi.fn(async (_s: string, a: string) => store.get(a) ?? null),
    deletePassword: vi.fn(async (_s: string, a: string) => store.delete(a)),
  },
}));

import { deleteSession, loadSession, saveSession } from "./session.js";

describe("session storage", () => {
  beforeEach(() => store.clear());

  it("round-trips a session", async () => {
    await saveSession("a@b.co", {
      serverUrl: "https://api.standardnotes.com",
      email: "a@b.co",
      sessionPayload: { access_token: "a", refresh_token: "b" },
      masterKeyHex: "00".repeat(32),
      keyParams: { version: "004" },
      savedAt: new Date().toISOString(),
    });
    const loaded = await loadSession("a@b.co");
    expect(loaded?.email).toBe("a@b.co");
    expect(loaded?.keyParams).toEqual({ version: "004" });
  });

  it("returns null when missing", async () => {
    expect(await loadSession("missing@x.co")).toBeNull();
  });

  it("throws on corrupt payload", async () => {
    store.set("corrupt@x.co", "{not json");
    await expect(loadSession("corrupt@x.co")).rejects.toThrow(/corrupt/);
  });

  it("deletes", async () => {
    await saveSession("a@b.co", {
      serverUrl: "u",
      email: "a@b.co",
      sessionPayload: { access_token: "", refresh_token: "" },
      masterKeyHex: "00".repeat(32),
      keyParams: {},
      savedAt: "",
    });
    expect(await deleteSession("a@b.co")).toBe(true);
    expect(await loadSession("a@b.co")).toBeNull();
  });

  it("rejects empty email", async () => {
    await expect(loadSession("")).rejects.toThrow(/email/);
  });
});
