import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "./security/logger.js";
import {
  CONFIRM_ENV,
  confirmationDisabled,
  requireConfirmation,
} from "./security/confirm.js";
import { createClientFromSession, type SnClient } from "./sn/client.js";
import {
  createInput,
  createManyInput,
  deleteInput,
  getInput,
  listInput,
  registerNoteHandlers,
  searchInput,
  statsInput,
  updateInput,
} from "./tools/notes.js";
import {
  registerTagHandlers,
  syncInput,
  tagsAttachInput,
  tagsCreateInput,
  tagsDeleteInput,
  tagsDetachInput,
  tagsGetInput,
  tagsListInput,
  tagsUpdateInput,
} from "./tools/tags.js";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Tool annotations let clients render read-only vs. destructive calls
// differently and apply their own permission policies. They are hints only;
// the hard gate for deletes is `requireConfirmation` below.
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const OVERWRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export async function startServer(): Promise<void> {
  const serverUrl =
    process.env.SN_SERVER_URL ?? "https://api.standardnotes.com";
  const email = requiredEnv("SN_EMAIL");

  const client = await createClientFromSession({ serverUrl, email });
  const h = registerNoteHandlers(client);
  const t = registerTagHandlers(client);

  const server = new McpServer({
    name: "mcp-standardnotes",
    version: "0.1.0",
  });

  const wrap =
    <T>(fn: (raw: T) => Promise<unknown>) =>
    async (args: T) => {
      const result = await fn(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    };

  // Handlers take `raw: unknown` and re-validate with zod themselves, so the
  // callback is typed loosely here; the SDK still derives the JSON schema it
  // advertises to clients from `shape`.
  const register = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    annotations: ToolAnnotations,
    fn: (raw: unknown) => Promise<unknown>,
  ): void => {
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations },
      (args: unknown) => wrap(fn)(args),
    );
  };

  // ----- Destructive tools: always confirmed by the user, every call -----

  const confirmedNoteDelete = async (raw: unknown) => {
    const { uuid, permanent } = deleteInput.parse(raw);
    const existing = await client.getNote(uuid);
    if (!existing) throw new Error(`Note ${uuid} not found`);
    const title = existing.protected ? "[Protected]" : existing.title || "(untitled)";
    await requireConfirmation(server, {
      action: permanent
        ? `Permanently delete note "${title}"`
        : `Move note "${title}" to Trash`,
      details: permanent
        ? `UUID ${uuid}. This bypasses Trash and removes the note and its history from the server.`
        : `UUID ${uuid}. It can be restored from Trash in the Standard Notes app.`,
    });
    return h.notes_delete(raw);
  };

  const confirmedTagDelete = async (raw: unknown) => {
    const { uuid } = tagsDeleteInput.parse(raw);
    const existing = await client.getTag(uuid);
    if (!existing) throw new Error(`Tag ${uuid} not found`);
    await requireConfirmation(server, {
      action: `Permanently delete tag "${existing.title || "(untitled)"}"`,
      details:
        `UUID ${uuid}, attached to ${existing.noteUuids.length} note(s). ` +
        `Tags have no Trash; the notes themselves are not deleted.`,
    });
    return t.tags_delete(raw);
  };

  // ----- Registration -----

  register(
    "notes_list",
    "List notes (decrypted locally). Returns uuid/title/updatedAt/preview. Optional `tag` filters by tag UUID or title; set `includeDescendants: true` to also include notes filed under any child/grandchild tag (SN folder behavior).",
    listInput.shape,
    READ_ONLY,
    h.notes_list,
  );
  register(
    "notes_stats",
    "Vault statistics: counts (total/active/trashed), tags, byNoteType, sizes, oldest/newest/largest note.",
    statsInput.shape,
    READ_ONLY,
    h.notes_stats,
  );
  register(
    "notes_search",
    "Full-text search across decrypted notes.",
    searchInput.shape,
    READ_ONLY,
    h.notes_search,
  );
  register(
    "notes_get",
    "Fetch a single note's full content by UUID.",
    getInput.shape,
    READ_ONLY,
    h.notes_get,
  );
  register("notes_create", "Create a new note.", createInput.shape, WRITE, h.notes_create);
  register(
    "notes_create_many",
    "Create up to 50 notes in a single sync push. Returns the list of created uuid+title.",
    createManyInput.shape,
    WRITE,
    h.notes_create_many,
  );
  register(
    "notes_update",
    "Update an existing note by UUID.",
    updateInput._def.schema.shape,
    OVERWRITE,
    h.notes_update,
  );
  register(
    "notes_delete",
    "Trash a note (permanent=true purges irreversibly). The user is asked to confirm every call before anything is deleted.",
    deleteInput.shape,
    DESTRUCTIVE,
    confirmedNoteDelete,
  );
  register(
    "tags_list",
    "List all tags (uuid, title, updatedAt, noteCount, parentUuid).",
    tagsListInput.shape,
    READ_ONLY,
    t.tags_list,
  );
  register(
    "tags_get",
    "Fetch a single tag (title, linked note UUIDs, parentUuid) by UUID.",
    tagsGetInput.shape,
    READ_ONLY,
    t.tags_get,
  );
  register(
    "tags_create",
    "Create a new tag. Pass `parent` (tag UUID) to nest it under a folder.",
    tagsCreateInput.shape,
    WRITE,
    t.tags_create,
  );
  register(
    "tags_update",
    "Rename a tag and/or move it in the folder hierarchy. `parent`: tag UUID to re-parent, null to detach, omit to leave unchanged.",
    tagsUpdateInput._def.schema.shape,
    OVERWRITE,
    t.tags_update,
  );
  register(
    "tags_delete",
    "Delete a tag (permanent — tags have no trash state). The user is asked to confirm every call before anything is deleted.",
    tagsDeleteInput.shape,
    DESTRUCTIVE,
    confirmedTagDelete,
  );
  register(
    "tags_attach",
    "Attach an existing tag to a note.",
    tagsAttachInput.shape,
    WRITE,
    t.tags_attach,
  );
  register(
    "tags_detach",
    "Remove a tag from a note.",
    tagsDetachInput.shape,
    WRITE,
    t.tags_detach,
  );
  register(
    "sync",
    "Force a full sync with the server. Returns decrypted note/tag counts.",
    syncInput.shape,
    READ_ONLY,
    t.sync,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (confirmationDisabled()) {
    logger.warn(
      `${CONFIRM_ENV}=off — notes_delete and tags_delete will run without asking the user`,
    );
  }
  logger.info("MCP StandardNotes ready on stdio");
}

export type { SnClient };
