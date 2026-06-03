import { z } from "zod";
import type { SnClient } from "../sn/client.js";
import { NOTE_TYPES, type Note, type NoteSummary } from "../sn/types.js";

const MAX_TEXT_BYTES = 10 * 1024 * 1024;

export const uuidSchema = z.string().uuid();

export const noteTypeSchema = z.enum(NOTE_TYPES);

export const listInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  includeTrashed: z.boolean().default(false),
  tag: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Filter by tag UUID or title (case-insensitive)"),
});

export const statsInput = z.object({});

export const searchInput = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(20),
});

export const getInput = z.object({ uuid: uuidSchema });

const tagsArraySchema = z.array(uuidSchema).max(64);

export const createInput = z.object({
  title: z.string().max(500),
  text: z
    .string()
    .max(MAX_TEXT_BYTES)
    .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_TEXT_BYTES, {
      message: "text exceeds 10MB",
    }),
  noteType: noteTypeSchema.optional(),
  tags: tagsArraySchema.optional(),
});

export const createManyInput = z.object({
  notes: z.array(createInput).min(1).max(50),
});

export const updateInput = z
  .object({
    uuid: uuidSchema,
    title: z.string().max(500).optional(),
    text: z.string().max(MAX_TEXT_BYTES).optional(),
    noteType: noteTypeSchema.optional(),
    tags: tagsArraySchema.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.text !== undefined ||
      v.noteType !== undefined ||
      v.tags !== undefined,
    {
      message: "provide at least one of title, text, noteType, or tags",
    },
  );

export const deleteInput = z.object({
  uuid: uuidSchema,
  permanent: z.boolean().default(false),
});

// `protected` (SN top-level content flag) = the user has marked the note as
// requiring re-auth to view. We surface it as a masked summary in listings and
// refuse to read/update/delete the content via MCP — pushing the body into an
// LLM context would defeat the protection the user explicitly asked for.
// `locked` (SN appData edit-lock) = read-only. Content stays visible, only
// writes are refused.
function maskProtected<T extends NoteSummary>(n: T): T {
  return n.protected ? { ...n, title: "[Protected]", preview: "" } : n;
}

function refuseRead(note: Note | NoteSummary, op: string): never {
  throw new Error(
    `Note ${note.uuid} is protected — cannot ${op} via MCP. ` +
      `Open it in the Standard Notes app to view its contents.`,
  );
}

function refuseWrite(note: Note | NoteSummary, op: string): never {
  const reason = note.protected ? "protected" : "edit-locked";
  throw new Error(
    `Note ${note.uuid} is ${reason} — cannot ${op} via MCP. ` +
      `Unlock it in the Standard Notes app first.`,
  );
}

export function registerNoteHandlers(client: SnClient) {
  return {
    notes_list: async (raw: unknown) => {
      const args = listInput.parse(raw);
      const notes = await client.listNotes(args);
      return notes.map(maskProtected);
    },
    notes_search: async (raw: unknown) => {
      const { query, limit } = searchInput.parse(raw);
      const hits = await client.searchNotes(query, limit);
      return hits.map(maskProtected);
    },
    notes_get: async (raw: unknown) => {
      const { uuid } = getInput.parse(raw);
      const note = await client.getNote(uuid);
      if (!note) throw new Error(`Note ${uuid} not found`);
      if (note.protected) refuseRead(note, "read");
      return note;
    },
    notes_create: async (raw: unknown) => {
      const args = createInput.parse(raw);
      const uuid = await client.createNote(args);
      await client.sync();
      return { uuid };
    },
    notes_create_many: async (raw: unknown) => {
      const { notes } = createManyInput.parse(raw);
      const created = await client.createNotesBatch(notes);
      await client.sync();
      return { created };
    },
    notes_update: async (raw: unknown) => {
      const args = updateInput.parse(raw);
      const existing = await client.getNote(args.uuid);
      if (existing && (existing.protected || existing.locked)) {
        refuseWrite(existing, "update");
      }
      await client.updateNote(args);
      await client.sync();
      return { ok: true };
    },
    notes_delete: async (raw: unknown) => {
      const { uuid, permanent } = deleteInput.parse(raw);
      const existing = await client.getNote(uuid);
      if (existing && (existing.protected || existing.locked)) {
        refuseWrite(existing, "delete");
      }
      await client.deleteNote(uuid, permanent);
      await client.sync();
      return { ok: true, permanent };
    },
    notes_stats: async (raw: unknown) => {
      statsInput.parse(raw ?? {});
      return client.stats();
    },
  };
}

export type NoteHandlers = ReturnType<typeof registerNoteHandlers>;
