#!/usr/bin/env node
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import keytar from "keytar";

const KEYCHAIN_SERVICE = process.env.KEYCHAIN_SERVICE ?? "mcp-standardnotes";

type Target = "desktop" | "code";

export interface InstallEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ResolvedPaths {
  /** Absolute path to the Node.js binary that will run the server. */
  node: string;
  /** Absolute path to dist/index.js (the MCP server entrypoint). */
  server: string;
}

/** Returns absolute paths for node + the server entrypoint. */
export function resolvePaths(): ResolvedPaths {
  const here = dirname(fileURLToPath(import.meta.url));
  // install.js lives in dist/cli/, server entry is dist/index.js
  const server = resolve(here, "..", "index.js");
  return { node: process.execPath, server };
}

export function desktopConfigPath(): string {
  const p = platform();
  if (p === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (p === "win32") {
    const appdata = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appdata, "Claude", "claude_desktop_config.json");
  }
  throw new Error(
    `Claude Desktop is not available on ${p}. Use \`mcp-standardnotes-install code\` for Claude Code instead.`,
  );
}

async function readJsonOrEmpty(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Existing config at ${path} is not valid JSON; refusing to overwrite. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
}

async function backupOnce(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.bak-${stamp}`;
  await copyFile(path, backup);
  return backup;
}

async function pickEmail(): Promise<string> {
  if (process.env.SN_EMAIL) return process.env.SN_EMAIL;
  const creds = await keytar.findCredentials(KEYCHAIN_SERVICE);
  if (creds.length === 1 && creds[0]) return creds[0].account;
  if (creds.length === 0) {
    throw new Error(
      "No stored Standard Notes session found. Run `mcp-standardnotes-login` first.",
    );
  }
  // Multiple accounts — prompt
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  process.stdout.write("Multiple sessions found. Pick which email to use:\n");
  creds.forEach((c, i) => process.stdout.write(`  [${i + 1}] ${c.account}\n`));
  const answer = await new Promise<string>((res) =>
    rl.question("Number: ", (a) => {
      rl.close();
      res(a.trim());
    }),
  );
  const idx = Number(answer) - 1;
  const choice = creds[idx];
  if (!choice) throw new Error(`Invalid selection: ${answer}`);
  return choice.account;
}

export function buildEntry(
  paths: ResolvedPaths,
  email: string,
): InstallEntry {
  return {
    command: paths.node,
    args: [paths.server],
    env: { SN_EMAIL: email },
  };
}

export async function installDesktop(opts: {
  email: string;
  paths: ResolvedPaths;
  configPath?: string;
}): Promise<{ configPath: string; backup: string | null }> {
  const configPath = opts.configPath ?? desktopConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  const backup = await backupOnce(configPath);
  const config = await readJsonOrEmpty(configPath);
  const servers =
    (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  servers["mcp-standardnotes"] = buildEntry(opts.paths, opts.email);
  config.mcpServers = servers;
  await writeFile(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
  return { configPath, backup };
}

async function printCodeInstructions(
  paths: ResolvedPaths,
  email: string,
): Promise<void> {
  process.stdout.write(
    "For Claude Code, run this command (it shells out to the `claude` CLI):\n\n",
  );
  process.stdout.write(
    `  claude mcp add mcp-standardnotes "${paths.node}" "${paths.server}" --env SN_EMAIL=${email}\n\n`,
  );
  process.stdout.write(
    "If you don't have the `claude` CLI installed, add the same JSON entry manually to ~/.claude.json under `mcpServers`.\n",
  );
}

function parseTargets(argv: string[]): Target[] {
  const targets: Target[] = [];
  for (const a of argv) {
    if (a === "desktop" || a === "code") {
      if (!targets.includes(a)) targets.push(a);
    } else {
      throw new Error(
        `Unknown argument: "${a}". Usage: mcp-standardnotes-install [desktop] [code]`,
      );
    }
  }
  if (targets.length === 0) targets.push("desktop");
  return targets;
}

async function main(): Promise<void> {
  const targets = parseTargets(process.argv.slice(2));
  const paths = resolvePaths();
  if (!existsSync(paths.server)) {
    throw new Error(
      `Could not find the MCP server entrypoint at ${paths.server}. ` +
        `Reinstall the package: \`npm install -g mcp-standardnotes\`.`,
    );
  }
  const email = await pickEmail();

  for (const t of targets) {
    if (t === "desktop") {
      try {
        const { configPath, backup } = await installDesktop({ email, paths });
        process.stdout.write(
          `Updated Claude Desktop config at ${configPath}\n`,
        );
        if (backup) {
          process.stdout.write(`(previous config backed up to ${backup})\n`);
        }
        process.stdout.write(
          "Quit Claude Desktop fully (⌘Q on macOS) and relaunch to pick up the change.\n",
        );
      } catch (err) {
        process.stderr.write(
          `Desktop install failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    } else if (t === "code") {
      await printCodeInstructions(paths, email);
    }
  }
}

// Don't auto-run when imported (e.g. from login.ts or tests).
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}

