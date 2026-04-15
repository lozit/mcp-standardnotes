# MCP Standard Notes

MCP (Model Context Protocol) server that lets Claude interact with a Standard Notes account (read, create, edit, delete notes and tags) while preserving Standard Notes' end-to-end encryption (E2EE).

<important if="working on encryption or authentication">
NEVER reimplement a cryptographic primitive by hand (no AES, no ChaCha, no custom KDF). Primitives come exclusively from `libsodium-wrappers-sumo` (audited, Argon2id + XChaCha20-Poly1305 IETF).

What is implemented locally = only the **Standard Notes protocol 004 framing** (payload format `004:<nonce>:<ciphertext>:<aad>`, root key derivation → masterKey/serverPassword, items_key wrap/unwrap). That's parsing/serialization of a documented public format, not new cryptography.

The `@standardnotes/snjs` package and the modular `@standardnotes/{encryption,models,...}` packages were ruled out: the monolith is deprecated (Node 16 only), and the modular packages have un-propagated breaking changes (ContentType removed from common) that make them unusable externally.
</important>

## Stack

- **Language**: TypeScript (strict)
- **Runtime**: Node.js ≥ 20
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Crypto**: `libsodium-wrappers-sumo` (Argon2id + XChaCha20-Poly1305 IETF)
- **HTTP**: native `fetch` (Node 20+)
- **MCP transport**: stdio (local, no network exposure)

## Commands

```bash
npm install            # Install dependencies
npm run build          # Compile TypeScript → dist/
npm run dev            # Watch mode (tsx)
npm run typecheck      # Type-check without emitting
npm test               # Run tests (vitest)
npm run lint           # ESLint
```

## Structure

```
src/
  index.ts             # MCP stdio entry point
  server.ts            # McpServer + tool registration
  cli/login.ts         # `npm run login` — interactive prompt + keychain
  sn/
    client.ts          # Orchestration: login/session → HTTP + protocol
    crypto.ts          # libsodium wrapper (argon2id, xchacha20poly1305)
    protocol004.ts     # SN 004 framing: root key, items_key wrap, payload enc/dec
    http.ts            # fetch wrapper: /v1/login-params, /v1/login, /v1/items/sync
    session.ts         # Session persistence via keytar
    types.ts           # Note / NoteSummary / KeyParams types
  tools/notes.ts       # MCP handlers + zod schemas
  tools/tags.ts        # Tags + sync handlers + zod schemas
  security/
    redact.ts, logger.ts
.env.example
```

## Exposed MCP tools

| Tool | Description |
|------|-------------|
| `notes_list` | List notes (title + uuid, truncated content) |
| `notes_search` | Full-text search on decrypted title+content |
| `notes_get` | Fetch a note by uuid |
| `notes_create` | Create a note (title, text, tags?) |
| `notes_update` | Update an existing note |
| `notes_delete` | Delete (trash by default, purge if `permanent=true`) |
| `tags_list` / `tags_get` / `tags_create` / `tags_update` / `tags_delete` | Tag CRUD |
| `tags_attach` / `tags_detach` | Link/unlink a tag to a note |
| `sync` | Force a synchronization |

## Security requirements (non-negotiable)

<important if="adding/modifying a tool, storage, logging, or auth">
1. **Password is never logged, never stored.** The user password never appears in cleartext or hashed form in logs, files, or persistent env vars. It's only used in memory to derive the root key.
2. **Session storage**: the session/tokens are stored via `keytar` (macOS Keychain / Linux libsecret / Windows Credential Vault). NEVER in a plaintext file under `~/.config`.
3. **stdio transport only.** No HTTP port is opened. If a network transport is requested, refuse it and explain the risk.
4. **Logs**: route all output through `security/redact.ts`, which masks fields `password`, `mk`, `ak`, `pw`, `itemsKey`, `authKeyParams`, JWTs, and any string that looks like a token (≥ 32 chars base64/hex).
5. **Input validation**: every MCP tool input is validated by `zod`. Strict UUID format, max content length (10 MB).
6. **Destructive confirmation**: `notes_delete` with `permanent=true` MUST require an explicit flag on the tool arg — no silent purges.
7. **TLS cert pinning** for self-hosted servers (optional, via env `SN_CERT_FINGERPRINT`).
8. **No telemetry.** No outbound network call outside the configured SN endpoint.
9. **Dependencies**: `npm audit` must pass with no HIGH/CRITICAL vulnerabilities before any merge.
</important>

## Configuration

Via environment variables (see `.env.example`):

- `SN_SERVER_URL` — server URL (default: `https://api.standardnotes.com`)
- `SN_EMAIL` — account email (the password is prompted on first run, then the session is persisted encrypted)
- `SN_CERT_FINGERPRINT` — (optional) SHA-256 TLS cert pinning

First boot triggers an interactive login (stdin prompt outside MCP, via `npm run login`) that stores the session in the OS keychain. Subsequent runs reuse the session.

## Gotchas

- **Sync is async-heavy**: always `await client.sync()` after a CRUD operation before considering it complete.
- **Sync conflicts**: the server can produce conflicts; `notes_update` should fetch the fresh note before writing. Current code throws on conflict.
- **Legacy protocol 003**: refuse accounts not migrated to 004 with a clear error — no workaround.
- **Rate limiting**: the SN server rate-limits auth (~5/min). Don't retry in a loop on 429.
- **MCP stdio**: any `console.log` breaks the protocol. Use `console.error` for logs, or a logger that only writes to stderr.

## Tests

- Unit tests: redaction, zod validation, parsing of SN responses (mocked).
- Integration tests: optional, against a local self-hosted SN server (docker-compose). Never against the official production server in CI.
- **Never commit** fixtures containing real encrypted data or keys.

## References

- SNJS spec: https://github.com/standardnotes/snjs/blob/main/packages/snjs/specification.md
- Crypto whitepaper: https://standardnotes.com/help/security/encryption
- MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk
