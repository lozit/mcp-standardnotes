import { z } from "zod";
import type { SnClient } from "../sn/client.js";
import { NOTE_TYPES } from "../sn/types.js";

const MAX_TEXT_BYTES = 10 * 1024 * 1024;

export const uuidSchema = z.string().uuid();

export const noteTypeSchema = z.enum(NOTE_TYPES);

export const listInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  includeTrashed: z.boolean().default(false),
});

export const searchInput = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(20),
});

export const getInput = z.object({ uuid: uuidSchema });

export const createInput = z.object({
  title: z.string().max(500),
  text: z
    .string()
    .max(MAX_TEXT_BYTES)
    .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_TEXT_BYTES, {
      message: "text exceeds 10MB",
    }),
  noteType: noteTypeSchema.optional(),
});

export const updateInput = z
  .object({
    uuid: uuidSchema,
    title: z.string().max(500).optional(),
    text: z.string().max(MAX_TEXT_BYTES).optional(),
    noteType: noteTypeSchema.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.text !== undefined ||
      v.noteType !== undefined,
    {
      message: "provide at least one of title, text, or noteType",
    },
  );

export const deleteInput = z.object({
  uuid: uuidSchema,
  permanent: z.boolean().default(false),
});

export function registerNoteHandlers(client: SnClient) {
  return {
    notes_list: async (raw: unknown) => {
      const args = listInput.parse(raw);
      return client.listNotes(args);
    },
    notes_search: async (raw: unknown) => {
      const { query, limit } = searchInput.parse(raw);
      return client.searchNotes(query, limit);
    },
    notes_get: async (raw: unknown) => {
      const { uuid } = getInput.parse(raw);
      const note = await client.getNote(uuid);
      if (!note) throw new Error(`Note ${uuid} not found`);
      return note;
    },
    notes_create: async (raw: unknown) => {
      const args = createInput.parse(raw);
      const uuid = await client.createNote(args);
      await client.sync();
      return { uuid };
    },
    notes_update: async (raw: unknown) => {
      const args = updateInput.parse(raw);
      await client.updateNote(args);
      await client.sync();
      return { ok: true };
    },
    notes_delete: async (raw: unknown) => {
      const { uuid, permanent } = deleteInput.parse(raw);
      await client.deleteNote(uuid, permanent);
      await client.sync();
      return { ok: true, permanent };
    },
  };
}

export type NoteHandlers = ReturnType<typeof registerNoteHandlers>;
