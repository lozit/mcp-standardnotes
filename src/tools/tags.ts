import { z } from "zod";
import type { SnClient } from "../sn/client.js";

export const uuidSchema = z.string().uuid();

const titleSchema = z.string().min(1).max(256);

export const tagsListInput = z.object({});

export const tagsGetInput = z.object({ uuid: uuidSchema });

export const tagsCreateInput = z.object({ title: titleSchema });

export const tagsUpdateInput = z.object({
  uuid: uuidSchema,
  title: titleSchema,
});

export const tagsDeleteInput = z.object({ uuid: uuidSchema });

export const tagsAttachInput = z.object({
  noteUuid: uuidSchema,
  tagUuid: uuidSchema,
});

export const tagsDetachInput = tagsAttachInput;

export const syncInput = z.object({});

export function registerTagHandlers(client: SnClient) {
  return {
    tags_list: async (raw: unknown) => {
      tagsListInput.parse(raw ?? {});
      return client.listTags();
    },
    tags_get: async (raw: unknown) => {
      const { uuid } = tagsGetInput.parse(raw);
      const tag = await client.getTag(uuid);
      if (!tag) throw new Error(`Tag ${uuid} not found`);
      return tag;
    },
    tags_create: async (raw: unknown) => {
      const args = tagsCreateInput.parse(raw);
      const uuid = await client.createTag(args);
      await client.sync();
      return { uuid };
    },
    tags_update: async (raw: unknown) => {
      const args = tagsUpdateInput.parse(raw);
      await client.updateTag(args);
      await client.sync();
      return { ok: true };
    },
    tags_delete: async (raw: unknown) => {
      const { uuid } = tagsDeleteInput.parse(raw);
      await client.deleteTag(uuid);
      await client.sync();
      return { ok: true };
    },
    tags_attach: async (raw: unknown) => {
      const { noteUuid, tagUuid } = tagsAttachInput.parse(raw);
      await client.attachTag(noteUuid, tagUuid);
      await client.sync();
      return { ok: true };
    },
    tags_detach: async (raw: unknown) => {
      const { noteUuid, tagUuid } = tagsDetachInput.parse(raw);
      await client.detachTag(noteUuid, tagUuid);
      await client.sync();
      return { ok: true };
    },
    sync: async (raw: unknown) => {
      syncInput.parse(raw ?? {});
      return client.sync();
    },
  };
}

export type TagHandlers = ReturnType<typeof registerTagHandlers>;
