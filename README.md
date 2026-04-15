# mcp-standardnotes

MCP (Model Context Protocol) server that lets Claude read and write your [Standard Notes](https://standardnotes.com/) account while preserving end-to-end encryption (protocol 004, Argon2id + XChaCha20-Poly1305).

- **Local stdio only.** No network port exposed; your master key never leaves your machine.
- **Session persisted in OS keychain** (Keychain on macOS, libsecret on Linux, Credential Vault on Windows) — password is only used at login and never stored.
- **Works with the official Standard Notes cloud** (`https://api.standardnotes.com`) or self-hosted servers.
- **Tested against Claude Code, Claude Desktop (macOS)**; any MCP client supporting stdio transport will work.

## Tools exposed

| Tool | Description |
|------|-------------|
| `notes_list` | Paginated list of notes (uuid, title, preview, timestamps). |
| `notes_search` | Full-text search across decrypted note titles and bodies. |
| `notes_get` | Fetch a single note by uuid. |
| `notes_create` | Create a new note (markdown by default; supports `plain-text`, `markdown`, `super`, `code`, `rich-text`, `task`, `spreadsheet`, `authentication`). |
| `notes_update` | Update title / text / noteType of an existing note. |
| `notes_delete` | Trash a note, or purge permanently with `permanent: true`. |

Additional tools on the roadmap (tags, manual sync) are tracked in [ROADMAP.md](./ROADMAP.md).

## Requirements

- **Node.js ≥ 20** (the bundled libsodium WASM needs `??=` / modern JS).
- A Standard Notes account on protocol **004** (accounts created or upgraded since 2020 are on 004 by default; if login fails with "Account is not on protocol 004", upgrade via the official app).
- macOS / Linux / Windows with a working OS keychain (for session persistence via [`keytar`](https://www.npmjs.com/package/keytar)).

## Install

```bash
git clone https://github.com/lozit/mcp-standardnotes.git
cd mcp-standardnotes
npm install
npm run build
```

## First-time login

You need to authenticate once. The password is used in-memory to derive keys (Argon2id) and is never written to disk.

```bash
npm run login
```

You'll be prompted for email and password. On success, an encrypted session (access token + masterKey hex) is stored in your OS keychain under service `mcp-standardnotes` / account `<your-email>`. Subsequent runs reuse the session automatically.

To log out, delete the keychain entry:

```bash
# macOS
security delete-generic-password -s mcp-standardnotes -a <your-email>
```

## Running the server

### Claude Code

Add this to your project or user MCP config (`~/.claude.json` under the relevant project, or `.mcp.json` in your repo):

```json
{
  "mcpServers": {
    "mcp-standardnotes": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-standardnotes/dist/index.js"],
      "env": {
        "SN_EMAIL": "your-account@example.com"
      }
    }
  }
}
```

Then `/mcp` in Claude Code to reconnect.

### Claude Desktop (macOS)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-standardnotes": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mcp-standardnotes/dist/index.js"],
      "env": {
        "SN_EMAIL": "your-account@example.com"
      }
    }
  }
}
```

**Important — Node version:** Claude Desktop does not inherit your shell's `nvm` setup. If you get `SyntaxError: Unexpected token '??='` in the logs (`~/Library/Logs/Claude/mcp-server-mcp-standardnotes.log`), Claude Desktop is resolving `node` to an older version from its PATH. Use the absolute path to a Node ≥ 20 binary (e.g. `/Users/you/.nvm/versions/node/v22.13.1/bin/node`).

Quit Claude Desktop completely (Cmd-Q) and relaunch.

### Any other MCP client

Run `node dist/index.js` with `SN_EMAIL` set in the environment. Transport is stdio.

## Configuration

All via environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `SN_EMAIL` | *required* | Your Standard Notes account email. Used as keychain lookup key — must match the email you used with `npm run login`. |
| `SN_SERVER_URL` | `https://api.standardnotes.com` | Sync server URL. Change for self-hosted instances. |
| `SN_CERT_FINGERPRINT` | *unset* | *(roadmap)* SHA-256 TLS certificate fingerprint to pin for self-hosted servers. |
| `KEYCHAIN_SERVICE` | `mcp-standardnotes` | Override the keychain service name (useful for running multiple accounts). |

## Security model

The project treats secrets very conservatively. Full rules in [`.claude/rules/security.md`](.claude/rules/security.md):

- Password only lives in RAM during key derivation (Argon2id via libsodium); never logged, never stored.
- Session + masterKey hex in OS keychain; never in plaintext files.
- stdio transport only — **no network port is ever opened**. Adding an HTTP transport would require modifying `CLAUDE.md` first and is actively discouraged.
- All tool inputs validated by zod (uuid format, 10 MB max content length).
- Destructive operations (`notes_delete permanent=true`) require explicit flag — no silent purges.
- All logs routed through `src/security/redact.ts` which masks password / mk / ak / itemsKey / JWT / session-token-like strings. Stdout is reserved for MCP protocol; logs go to stderr.
- `npm audit` HIGH/CRITICAL is a merge blocker.
- Cryptography uses only audited primitives from `libsodium-wrappers-sumo`. No hand-rolled AES, ChaCha, or KDF. Only the **framing** of Standard Notes protocol 004 (payload format parsing, root key derivation, items_key wrapping) is implemented locally.

## How it works (protocol 004 in one paragraph)

At login: Argon2id(password, salt=sha256(email:pw_nonce)[:16], ops=5, mem=64MB) → 64 bytes split into `masterKey` (first 32) and `serverPassword` (last 32, hex). `serverPassword` is sent to `/v2/login` with a PKCE code verifier; `masterKey` stays local. The server returns an access_token + a list of `SN|ItemsKey` items encrypted under `masterKey`. Each items_key (K) is used to encrypt notes: per-item random key K' is generated, note content is AEAD-encrypted under K' (XChaCha20-Poly1305 IETF), K' itself is AEAD-encrypted under K. Payloads are serialized as `004:<nonce_hex>:<ciphertext_b64>:<aad_b64>:<additional_data_b64>`. AAD is the utf-8 bytes of the base64-encoded `{u: item_uuid, v: "004"}` JSON object. Signing (Ed25519 over plaintext hash) is required only for items in shared vaults; personal notes use `{}` for additional_data.

See `src/sn/protocol004.ts` and Standard Notes' own [encryption whitepaper](https://standardnotes.com/help/security/encryption) for details.

## Development

```bash
npm run dev         # watch mode (tsx)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest run
npm run audit       # npm audit, fails on HIGH/CRITICAL
```

Additional CLIs under `src/cli/`:

- `npm run login` — interactive login, stores session.
- `npm run diag` — low-level protocol 004 sanity checks (key derivation, items_key decryption). Prompts for password; does not persist anything.
- `npm run dump-note -- <uuid-or-title>` — decrypt and print a note's raw content JSON + server item fields (for debugging payload compatibility with the official SN app).

### Project layout

```
src/
  index.ts              # MCP stdio entry point
  server.ts             # McpServer + tool registration
  cli/
    login.ts            # `npm run login`
    diag.ts             # low-level protocol diagnostics
    dump-note.ts        # decrypt-and-print for debugging
  sn/
    client.ts           # Orchestration: login/session → HTTP + protocol
    crypto.ts           # Thin wrapper over libsodium (argon2id, xchacha20poly1305, hex/b64)
    protocol004.ts      # Framing: root key derivation, items_key decryption, note enc/dec
    http.ts             # fetch wrapper for /v2/login-params, /v2/login, /v1/items
    session.ts          # keychain persistence via keytar
    types.ts            # Note / NoteSummary / NoteType
  tools/
    notes.ts            # MCP handlers + zod schemas
  security/
    redact.ts           # Redact secrets from any object before logging
    logger.ts           # stderr-only logger using redact
```

## Troubleshooting

**"No session found. Run `npm run login` to authenticate first."** — The keychain lookup `(service: mcp-standardnotes, account: SN_EMAIL)` found nothing. Make sure `SN_EMAIL` matches the email you used at login exactly.

**"Account is not on protocol 004..."** — Legacy 003 accounts are rejected. Upgrade via the official Standard Notes app (Preferences → Security → Upgrade Encryption).

**Notes created via MCP don't appear in the official SN app.** — This was a known bug fixed in early 2026: AAD `kp` field must be omitted for items-key-encrypted notes (only included for items_keys encrypted under the root key). If you see this on an old version, update.

**Server disconnects immediately in Claude Desktop, logs show `SyntaxError: Unexpected token '??='`** — Node < 15 on Claude Desktop's PATH. Use an absolute path to a Node ≥ 20 binary in the `command` field (see the Claude Desktop section above).

**Rate limited (429) after repeated logins** — Standard Notes caps auth at ~5/min. Wait a minute before retrying; don't loop.

**Sync returns conflicts** — On create/update, if the server returns conflicts, the MCP throws with the conflict payload instead of silently swallowing. For `notes_update`, the common cause is a stale `updated_at_timestamp` — fetch the note fresh (`notes_get`) and retry.

## Contributing

PRs welcome. Please:

1. Keep the security rules in [`.claude/rules/security.md`](.claude/rules/security.md) intact.
2. Never commit fixtures containing real encrypted data or keys.
3. Run `npm run typecheck && npm run lint && npm test && npm run audit` before opening a PR.
4. For cryptography-touching changes, open an issue first to discuss scope.

## License

[GNU Affero General Public License v3.0 or later](./LICENSE).

If you host a modified version as a network service, you must publish your source modifications under the same license.

## Credits

- [Standard Notes](https://standardnotes.com/) for the encryption design and public API.
- [Model Context Protocol](https://modelcontextprotocol.io) and [Anthropic](https://www.anthropic.com) for the MCP SDK.
- [libsodium](https://doc.libsodium.org/) by Frank Denis, exposed via [libsodium-wrappers-sumo](https://github.com/jedisct1/libsodium.js).
