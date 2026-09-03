import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SnClient } from "./sn/client.js";

// Replace the real SN client (needs a keychain session + network) with a
// stub so we can exercise the MCP surface end to end over an in-memory
// transport with a real MCP Client on the other side.
const stub = {
  getNote: vi.fn(),
  getTag: vi.fn(),
  deleteNote: vi.fn(async () => undefined),
  deleteTag: vi.fn(async () => undefined),
  sync: vi.fn(async () => ({ notes: 0, tags: 0, syncedAt: "" })),
} as unknown as SnClient & {
  getNote: ReturnType<typeof vi.fn>;
  getTag: ReturnType<typeof vi.fn>;
  deleteNote: ReturnType<typeof vi.fn>;
  deleteTag: ReturnType<typeof vi.fn>;
};

vi.mock("./sn/client.js", () => ({
  createClientFromSession: async () => stub,
}));

// Swap the stdio transport for the server half of an in-memory pair so a
// real MCP Client can drive the module exactly as a desktop client would.
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", async () => {
  const [{ InMemoryTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  return {
    StdioServerTransport: class {
      // McpServer.connect(transport) is invoked by startServer(); hand it the
      // server side of a linked pair and stash the client side globally.
      constructor() {
        const [c, s] = InMemoryTransport.createLinkedPair();
        (globalThis as { __clientTransport?: unknown }).__clientTransport = c;
        return s as unknown as object;
      }
    },
  };
});

const NOTE_UUID = "11111111-1111-4111-8111-111111111111";
const TAG_UUID = "22222222-2222-4222-8222-222222222222";

async function connect(elicit?: (msg: string) => Promise<unknown>) {
  process.env.SN_EMAIL = "test@example.com";
  const { startServer } = await import("./server.js");
  await startServer();
  const transport = (globalThis as { __clientTransport?: unknown })
    .__clientTransport as InstanceType<typeof InMemoryTransport>;
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: elicit ? { elicitation: {} } : {} },
  );
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) =>
      (await elicit(req.params.message)) as never,
    );
  }
  await client.connect(transport);
  return client;
}

beforeEach(() => {
  vi.resetModules();
  stub.getNote.mockReset();
  stub.getTag.mockReset();
  stub.deleteNote.mockClear();
  stub.deleteTag.mockClear();
  stub.getNote.mockResolvedValue({
    uuid: NOTE_UUID,
    title: "Tax records",
    text: "",
    protected: false,
    locked: false,
    trashed: false,
    tags: [],
    noteType: "markdown",
    createdAt: "",
    updatedAt: "",
  });
  stub.getTag.mockResolvedValue({
    uuid: TAG_UUID,
    title: "Finance",
    noteUuids: [NOTE_UUID],
    parentUuid: null,
    createdAt: "",
    updatedAt: "",
  });
});

describe("MCP surface", () => {
  it("advertises destructive/read-only annotations", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName["notes_delete"]?.destructiveHint).toBe(true);
    expect(byName["tags_delete"]?.destructiveHint).toBe(true);
    expect(byName["notes_get"]?.readOnlyHint).toBe(true);
    expect(byName["notes_list"]?.readOnlyHint).toBe(true);
    expect(byName["notes_create"]?.destructiveHint).toBe(false);
    await client.close();
  });

  it("refuses delete when the client cannot elicit, and touches nothing", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "notes_delete",
      arguments: { uuid: NOTE_UUID, permanent: true },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/does not support elicitation/);
    expect(stub.deleteNote).not.toHaveBeenCalled();
    await client.close();
  });

  it("refuses delete when the user declines the prompt", async () => {
    const seen: string[] = [];
    const client = await connect(async (msg) => {
      seen.push(msg);
      return { action: "decline" };
    });
    const res = await client.callTool({
      name: "notes_delete",
      arguments: { uuid: NOTE_UUID, permanent: true },
    });
    expect(res.isError).toBe(true);
    expect(seen[0]).toMatch(/Permanently delete note "Tax records"/);
    expect(stub.deleteNote).not.toHaveBeenCalled();
    await client.close();
  });

  it("deletes only after the user ticks confirm, and asks again next time", async () => {
    let calls = 0;
    const client = await connect(async () => {
      calls += 1;
      return { action: "accept", content: { confirm: true } };
    });
    const a = await client.callTool({
      name: "notes_delete",
      arguments: { uuid: NOTE_UUID, permanent: false },
    });
    expect(a.isError).toBeFalsy();
    expect(stub.deleteNote).toHaveBeenCalledWith(NOTE_UUID, false);

    const b = await client.callTool({
      name: "tags_delete",
      arguments: { uuid: TAG_UUID },
    });
    expect(b.isError).toBeFalsy();
    expect(stub.deleteTag).toHaveBeenCalledWith(TAG_UUID);
    expect(calls).toBe(2);
    await client.close();
  });

  it("does not reveal a protected note's title in the prompt", async () => {
    stub.getNote.mockResolvedValueOnce({
      uuid: NOTE_UUID,
      title: "SECRET",
      text: "",
      protected: true,
      locked: false,
      trashed: false,
      tags: [],
      noteType: "markdown",
      createdAt: "",
      updatedAt: "",
    });
    const seen: string[] = [];
    const client = await connect(async (msg) => {
      seen.push(msg);
      return { action: "cancel" };
    });
    await client.callTool({
      name: "notes_delete",
      arguments: { uuid: NOTE_UUID, permanent: false },
    });
    expect(seen[0]).not.toContain("SECRET");
    expect(seen[0]).toContain("[Protected]");
    await client.close();
  });
});
