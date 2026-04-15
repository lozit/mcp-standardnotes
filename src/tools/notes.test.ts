import { describe, expect, it, vi } from "vitest";
import type { SnClient } from "../sn/client.js";
import { registerNoteHandlers } from "./notes.js";

function fakeClient(): SnClient {
  return {
    listNotes: vi.fn(async () => []),
    searchNotes: vi.fn(async () => []),
    getNote: vi.fn(async () => null),
    createNote: vi.fn(async () => "11111111-1111-4111-8111-111111111111"),
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
      notes: 0,
      tags: 0,
      syncedAt: "2026-04-15T00:00:00Z",
    })),
  };
}

describe("tool input validation", () => {
  it("notes_list applies defaults", async () => {
    const c = fakeClient();
    const h = registerNoteHandlers(c);
    await h.notes_list({});
    expect(c.listNotes).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      includeTrashed: false,
    });
  });

  it("notes_list rejects limit > 200", async () => {
    const h = registerNoteHandlers(fakeClient());
    await expect(h.notes_list({ limit: 500 })).rejects.toThrow();
  });

  it("notes_get rejects non-uuid", async () => {
    const h = registerNoteHandlers(fakeClient());
    await expect(h.notes_get({ uuid: "nope" })).rejects.toThrow();
  });

  it("notes_update requires at least one field", async () => {
    const h = registerNoteHandlers(fakeClient());
    await expect(
      h.notes_update({ uuid: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toThrow();
  });

  it("notes_delete defaults permanent=false", async () => {
    const c = fakeClient();
    const h = registerNoteHandlers(c);
    await h.notes_delete({ uuid: "11111111-1111-4111-8111-111111111111" });
    expect(c.deleteNote).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      false,
    );
  });

  it("notes_create syncs after create", async () => {
    const c = fakeClient();
    const h = registerNoteHandlers(c);
    await h.notes_create({ title: "t", text: "body" });
    expect(c.sync).toHaveBeenCalled();
  });

  it("notes_create forwards tags", async () => {
    const c = fakeClient();
    const h = registerNoteHandlers(c);
    const tagUuid = "22222222-2222-4222-8222-222222222222";
    await h.notes_create({ title: "t", text: "body", tags: [tagUuid] });
    expect(c.createNote).toHaveBeenCalledWith({
      title: "t",
      text: "body",
      tags: [tagUuid],
    });
  });

  it("notes_create rejects malformed tag uuid", async () => {
    const h = registerNoteHandlers(fakeClient());
    await expect(
      h.notes_create({ title: "t", text: "body", tags: ["nope"] }),
    ).rejects.toThrow();
  });

  it("notes_update accepts tags-only change", async () => {
    const c = fakeClient();
    const h = registerNoteHandlers(c);
    await h.notes_update({
      uuid: "11111111-1111-4111-8111-111111111111",
      tags: [],
    });
    expect(c.updateNote).toHaveBeenCalled();
  });
});
