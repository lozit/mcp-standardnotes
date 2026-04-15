import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { logger } from "./security/logger.js";
import { createClientFromSession } from "./sn/client.js";
import {
  createInput,
  deleteInput,
  getInput,
  listInput,
  registerNoteHandlers,
  searchInput,
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

  server.tool(
    "notes_list",
    "List notes (decrypted locally). Returns uuid/title/updatedAt/preview.",
    listInput.shape,
    wrap(h.notes_list),
  );
  server.tool(
    "notes_search",
    "Full-text search across decrypted notes.",
    searchInput.shape,
    wrap(h.notes_search),
  );
  server.tool(
    "notes_get",
    "Fetch a single note's full content by UUID.",
    getInput.shape,
    wrap(h.notes_get),
  );
  server.tool(
    "notes_create",
    "Create a new note.",
    createInput.shape,
    wrap(h.notes_create),
  );
  server.tool(
    "notes_update",
    "Update an existing note by UUID.",
    updateInput._def.schema.shape,
    wrap(h.notes_update),
  );
  server.tool(
    "notes_delete",
    "Trash a note (permanent=true purges irreversibly).",
    deleteInput.shape,
    wrap(h.notes_delete),
  );
  server.tool(
    "tags_list",
    "List all tags (uuid, title, updatedAt, noteCount).",
    tagsListInput.shape,
    wrap(t.tags_list),
  );
  server.tool(
    "tags_get",
    "Fetch a single tag (title + linked note UUIDs) by UUID.",
    tagsGetInput.shape,
    wrap(t.tags_get),
  );
  server.tool(
    "tags_create",
    "Create a new tag.",
    tagsCreateInput.shape,
    wrap(t.tags_create),
  );
  server.tool(
    "tags_update",
    "Rename an existing tag.",
    tagsUpdateInput.shape,
    wrap(t.tags_update),
  );
  server.tool(
    "tags_delete",
    "Delete a tag (permanent — tags have no trash state).",
    tagsDeleteInput.shape,
    wrap(t.tags_delete),
  );
  server.tool(
    "tags_attach",
    "Attach an existing tag to a note.",
    tagsAttachInput.shape,
    wrap(t.tags_attach),
  );
  server.tool(
    "tags_detach",
    "Remove a tag from a note.",
    tagsDetachInput.shape,
    wrap(t.tags_detach),
  );
  server.tool(
    "sync",
    "Force a full sync with the server. Returns decrypted note/tag counts.",
    syncInput.shape,
    wrap(t.sync),
  );

  // Silence zod unused warning on strict builds
  void z;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP StandardNotes ready on stdio");
}
