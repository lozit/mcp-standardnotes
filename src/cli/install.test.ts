import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// keytar is a top-level import in install.ts. Mock it so the test doesn't
// dlopen libsecret on the Linux CI runner (which doesn't have it installed).
vi.mock("keytar", () => ({
  default: {
    findCredentials: vi.fn(async () => []),
    getPassword: vi.fn(async () => null),
    setPassword: vi.fn(async () => undefined),
    deletePassword: vi.fn(async () => true),
  },
}));

import { buildEntry, installDesktop, isMainModule } from "./install.js";

const fakePaths = {
  node: "/abs/path/to/node",
  server: "/abs/path/to/dist/index.js",
};

describe("install — buildEntry", () => {
  it("uses absolute node + server paths and sets SN_EMAIL", () => {
    expect(buildEntry(fakePaths, "a@b.co")).toEqual({
      command: "/abs/path/to/node",
      args: ["/abs/path/to/dist/index.js"],
      env: { SN_EMAIL: "a@b.co" },
    });
  });
});

describe("install — installDesktop (against a tmpdir)", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-sn-install-test-"));
    configPath = join(dir, "claude_desktop_config.json");
  });
  afterEach(() => {
    // tmpdir auto-cleans; nothing else to do
  });

  it("creates the config when it doesn't exist", async () => {
    const { backup } = await installDesktop({
      email: "a@b.co",
      paths: fakePaths,
      configPath,
    });
    expect(backup).toBeNull();
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.mcpServers["mcp-standardnotes"]).toEqual(
      buildEntry(fakePaths, "a@b.co"),
    );
  });

  it("preserves other mcpServers entries when merging", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "some-other-server": { command: "/usr/bin/other", args: [] },
        },
      }),
    );
    await installDesktop({ email: "a@b.co", paths: fakePaths, configPath });
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.mcpServers["some-other-server"]).toBeDefined();
    expect(written.mcpServers["mcp-standardnotes"].env.SN_EMAIL).toBe("a@b.co");
  });

  it("backs up the existing config before overwriting", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { "mcp-standardnotes": { command: "old" } } }),
    );
    const { backup } = await installDesktop({
      email: "a@b.co",
      paths: fakePaths,
      configPath,
    });
    expect(backup).not.toBeNull();
    expect(backup).toMatch(/\.bak-/);
    const backedUp = JSON.parse(await readFile(backup as string, "utf8"));
    expect(backedUp.mcpServers["mcp-standardnotes"].command).toBe("old");
  });

  it("overwrites a stale mcp-standardnotes entry without duplicating", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "mcp-standardnotes": { command: "/old/node", args: ["/old/path"] },
        },
      }),
    );
    await installDesktop({ email: "a@b.co", paths: fakePaths, configPath });
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(Object.keys(written.mcpServers)).toEqual(["mcp-standardnotes"]);
    expect(written.mcpServers["mcp-standardnotes"].command).toBe(fakePaths.node);
  });

  it("refuses to overwrite an existing malformed config", async () => {
    await writeFile(configPath, "{ not json");
    await expect(
      installDesktop({ email: "a@b.co", paths: fakePaths, configPath }),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("install — isMainModule", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-sn-ismain-test-"));
  });

  it("returns true when argv[1] is a symlink to the real module file", async () => {
    // Mirrors how npm installs global bins: /usr/bin/foo -> dist/cli/foo.js.
    const realFile = join(dir, "install.js");
    const binSymlink = join(dir, "mcp-standardnotes-install");
    await writeFile(realFile, "// placeholder\n");
    await symlink(realFile, binSymlink);

    const moduleUrl = pathToFileURL(realFile).href;
    expect(isMainModule(moduleUrl, binSymlink)).toBe(true);
  });

  it("returns true when argv[1] already matches the real path directly", async () => {
    const realFile = join(dir, "install.js");
    await writeFile(realFile, "// placeholder\n");
    expect(isMainModule(pathToFileURL(realFile).href, realFile)).toBe(true);
  });

  it("returns false for an unrelated file", async () => {
    const realFile = join(dir, "install.js");
    const otherFile = join(dir, "other.js");
    await writeFile(realFile, "// placeholder\n");
    await writeFile(otherFile, "// placeholder\n");
    expect(isMainModule(pathToFileURL(realFile).href, otherFile)).toBe(false);
  });

  it("returns false instead of throwing when argv[1] is missing or nonexistent", () => {
    const moduleUrl = pathToFileURL(join(dir, "install.js")).href;
    expect(isMainModule(moduleUrl, undefined)).toBe(false);
    expect(isMainModule(moduleUrl, join(dir, "does-not-exist.js"))).toBe(false);
  });
});
