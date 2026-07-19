import { describe, expect, it, vi } from "vitest";
import type { SnClient } from "../sn/client.js";
import { registerTagHandlers } from "./tags.js";

function fakeClient(): SnClient {
  return {
    listNotes: vi.fn(async () => []),
    stats: vi.fn(async () => ({
      notes: { total: 0, active: 0, trashed: 0 },
      tags: 0,
      byNoteType: {},
      totalTextBytes: 0,
      averageTextBytes: 0,
      largest: null,
      oldest: null,
      newest: null,
    })),
    searchNotes: vi.fn(async () => []),
    getNote: vi.fn(async () => null),
    createNote: vi.fn(async () => "11111111-1111-4111-8111-111111111111"),
    createNotesBatch: vi.fn(async () => []),
    updateNote: vi.fn(async () => undefined),
    deleteNote: vi.fn(async () => undefined),
    listTags: vi.fn(async () => []),
    getTag: vi.fn(async () => null),
    createTag: vi.fn(async () => "22222222-2222-4222-8222-222222222222"),
    updateTag: vi.fn(async () => undefined),
    deleteTag: vi.fn(async () => undefined),
    attachTag: vi.fn(async () => undefined),
    detachTag: vi.fn(async () => undefined),
    sync: vi.fn(async () => ({
      notes: 3,
      tags: 2,
      syncedAt: "2026-04-15T00:00:00Z",
    })),
  };
}

describe("tag tool input validation", () => {
  it("tags_create rejects empty title", async () => {
    const h = registerTagHandlers(fakeClient());
    await expect(h.tags_create({ title: "" })).rejects.toThrow();
  });

  it("tags_create rejects title > 256 chars", async () => {
    const h = registerTagHandlers(fakeClient());
    await expect(
      h.tags_create({ title: "x".repeat(257) }),
    ).rejects.toThrow();
  });

  it("tags_update requires uuid and title", async () => {
    const h = registerTagHandlers(fakeClient());
    await expect(
      h.tags_update({ uuid: "not-a-uuid", title: "x" }),
    ).rejects.toThrow();
  });

  it("tags_attach rejects malformed uuids", async () => {
    const h = registerTagHandlers(fakeClient());
    await expect(
      h.tags_attach({ noteUuid: "nope", tagUuid: "nope" }),
    ).rejects.toThrow();
  });

  it("tags_create triggers a post-create sync", async () => {
    const c = fakeClient();
    const h = registerTagHandlers(c);
    await h.tags_create({ title: "work" });
    expect(c.sync).toHaveBeenCalled();
  });

  it("sync returns the client's counts", async () => {
    const c = fakeClient();
    const h = registerTagHandlers(c);
    const res = await h.sync({});
    expect(res).toEqual({
      notes: 3,
      tags: 2,
      syncedAt: "2026-04-15T00:00:00Z",
    });
  });

  it("tags_create forwards an optional parent uuid to the client", async () => {
    const c = fakeClient();
    const h = registerTagHandlers(c);
    await h.tags_create({
      title: "child",
      parent: "33333333-3333-4333-8333-333333333333",
    });
    expect(c.createTag).toHaveBeenCalledWith({
      title: "child",
      parent: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("tags_create rejects a malformed parent uuid", async () => {
    const h = registerTagHandlers(fakeClient());
    await expect(
      h.tags_create({ title: "child", parent: "not-a-uuid" }),
    ).rejects.toThrow();
  });

  it("tags_update accepts parent-only (re-parent without rename)", async () => {
    const c = fakeClient();
    const h = registerTagHandlers(c);
    await h.tags_update({
      uuid: "44444444-4444-4444-8444-444444444444",
      parent: "55555555-5555-4555-8555-555555555555",
    });
    expect(c.updateTag).toHaveBeenCalledWith({
      uuid: "44444444-4444-4444-8444-444444444444",
      parent: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("tags_update accepts parent: null (detach from folder)", async () => {
    const c = fakeClient();
    const h = registerTagHandlers(c);
    await h.tags_update({
      uuid: "44444444-4444-4444-8444-444444444444",
      parent: null,
    });
    expect(c.updateTag).toHaveBeenCalledWith({
      uuid: "44444444-4444-4444-8444-444444444444",
      parent: null,
    });
  });

  it("tags_update requires at least one of title or parent", async () => {
    const h = registerTagHandlers(fakeClient());
    await expect(
      h.tags_update({ uuid: "44444444-4444-4444-8444-444444444444" }),
    ).rejects.toThrow(/at least one of title or parent/);
  });
});
