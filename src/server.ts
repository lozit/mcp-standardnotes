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

  // Silence zod unused warning on strict builds
  void z;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP StandardNotes ready on stdio");
}
