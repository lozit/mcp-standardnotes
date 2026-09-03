import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";

/**
 * Human-in-the-loop gate for destructive tools.
 *
 * Every call to a destructive tool must be approved by the *person* at the
 * client, via MCP elicitation, before the server touches the vault. The
 * model cannot satisfy this gate itself — the elicitation request is
 * rendered by the client UI and answered by the user.
 *
 * Fail closed: if the connected client does not advertise the elicitation
 * capability, the destructive call is refused outright rather than falling
 * back to "trust the model".
 *
 * Opt-out: `SN_CONFIRM_DESTRUCTIVE=off` (also `0` / `false`) disables the
 * gate for headless deployments (e.g. the remote-agent bridge in
 * docs/remote-agent-bridge.md, where no human is at the client). Any other
 * value, including unset, keeps it on. The setting is read once per call so
 * it cannot be flipped mid-session by anything other than the process env.
 */
export const CONFIRM_ENV = "SN_CONFIRM_DESTRUCTIVE";

export function confirmationDisabled(): boolean {
  const raw = (process.env[CONFIRM_ENV] ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false";
}

export class ConfirmationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationRequiredError";
  }
}

export async function requireConfirmation(
  server: McpServer,
  opts: { action: string; details: string },
): Promise<void> {
  if (confirmationDisabled()) {
    logger.warn("Destructive action executed WITHOUT user confirmation", {
      action: opts.action,
      reason: `${CONFIRM_ENV}=off`,
    });
    return;
  }

  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation) {
    throw new ConfirmationRequiredError(
      `${opts.action} refused: this MCP client does not support elicitation, ` +
        `so the user cannot be asked to confirm. Perform this action in the ` +
        `Standard Notes app instead.`,
    );
  }

  const result = await server.server.elicitInput({
    mode: "form",
    message:
      `Confirm: ${opts.action}\n\n${opts.details}\n\n` +
      `This cannot be undone. Tick the box to proceed.`,
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "I understand and want to proceed",
          description: opts.action,
          default: false,
        },
      },
      required: ["confirm"],
    },
  });

  const content = result.content as { confirm?: unknown } | undefined;
  const approved = result.action === "accept" && content?.confirm === true;
  logger.info("Destructive action confirmation", {
    action: opts.action,
    outcome: approved ? "approved" : result.action,
  });
  if (!approved) {
    throw new ConfirmationRequiredError(
      `${opts.action} cancelled: the user did not confirm.`,
    );
  }
}
