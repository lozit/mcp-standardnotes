import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CONFIRM_ENV,
  ConfirmationRequiredError,
  confirmationDisabled,
  requireConfirmation,
} from "./confirm.js";

afterEach(() => {
  delete process.env[CONFIRM_ENV];
});

function fakeServer(opts: {
  elicitation: boolean;
  reply?: { action: "accept" | "decline" | "cancel"; content?: unknown };
}) {
  const elicitInput = vi.fn(async () => opts.reply ?? { action: "cancel" });
  const server = {
    server: {
      getClientCapabilities: () => (opts.elicitation ? { elicitation: {} } : {}),
      elicitInput,
    },
  } as unknown as McpServer;
  return { server, elicitInput };
}

const req = { action: "Permanently delete note \"x\"", details: "uuid" };

describe("requireConfirmation", () => {
  it("refuses when the client cannot elicit (fail closed)", async () => {
    const { server, elicitInput } = fakeServer({ elicitation: false });
    await expect(requireConfirmation(server, req)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("passes only when the user accepts AND ticks confirm", async () => {
    const { server } = fakeServer({
      elicitation: true,
      reply: { action: "accept", content: { confirm: true } },
    });
    await expect(requireConfirmation(server, req)).resolves.toBeUndefined();
  });

  it("refuses accept without the confirm box ticked", async () => {
    const { server } = fakeServer({
      elicitation: true,
      reply: { action: "accept", content: { confirm: false } },
    });
    await expect(requireConfirmation(server, req)).rejects.toThrow(/did not confirm/);
  });

  it("refuses on decline and cancel", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const { server } = fakeServer({ elicitation: true, reply: { action } });
      await expect(requireConfirmation(server, req)).rejects.toThrow(/did not confirm/);
    }
  });

  it("is on by default and for unrecognised values", () => {
    expect(confirmationDisabled()).toBe(false);
    for (const v of ["on", "yes", "1", "true", "OFF please", ""]) {
      process.env[CONFIRM_ENV] = v;
      expect(confirmationDisabled()).toBe(false);
    }
  });

  it("can be switched off with SN_CONFIRM_DESTRUCTIVE=off|0|false", async () => {
    for (const v of ["off", "OFF", " 0 ", "false"]) {
      process.env[CONFIRM_ENV] = v;
      expect(confirmationDisabled()).toBe(true);
      // Even a client with no elicitation support passes when disabled.
      const { server, elicitInput } = fakeServer({ elicitation: false });
      await expect(requireConfirmation(server, req)).resolves.toBeUndefined();
      expect(elicitInput).not.toHaveBeenCalled();
    }
  });

  it("asks every time, with no caching between calls", async () => {
    const { server, elicitInput } = fakeServer({
      elicitation: true,
      reply: { action: "accept", content: { confirm: true } },
    });
    await requireConfirmation(server, req);
    await requireConfirmation(server, req);
    expect(elicitInput).toHaveBeenCalledTimes(2);
  });
});
