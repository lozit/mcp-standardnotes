# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.6] — 2026-06-03

### Added

- Surface Standard Notes' `protected` and `locked` flags on `DecryptedNote`, `Note`, and `NoteSummary`. `protected` (top-level content flag — SN requires re-auth to view) and `locked` (`appData["org.standardnotes.sn"].locked`, the edit-lock) are now read from the decrypted payload and surfaced through the API. Pinned by a round-trip test in `protocol004.test.ts`.

### Security

- **MCP tools now refuse to leak or modify user-protected notes.** `notes_list` and `notes_search` mask `title` and `preview` to `[Protected]` / `""` for notes the user marked `protected` in Standard Notes — those bodies never reach the LLM context. `notes_get` refuses to surface a protected note's content with an explicit error. `notes_update` and `notes_delete` refuse to write a note that is either `protected` or `locked` and do **not** call into the client when refused. `locked` notes stay readable (the SN semantics is read-only, not hidden), they're just write-blocked. Behavior pinned by 8 new tests in `tools/notes.test.ts`.

  Picked up from #1 by @s7eve1230, with two corrections: (i) the original PR
  bundled an already-merged `syncToken` reset (the cold-boot full-sync fix
  landed in 0.3.3) and (ii) it only blocked reads, leaving `notes_update` and
  `notes_delete` wide open — a protected note could be silently overwritten
  via its uuid. Thanks for surfacing the gap.

## [0.3.5] — 2026-06-03

### Fixed

- 2FA-enabled accounts can finally complete an interactive login. 0.3.4 fixed the *envelope* parsing for `mfa-required` errors but the try/catch was still around the wrong call — `http.login()`. Server-side, Standard Notes verifies MFA inside the `/v2/login-params` handler (`BaseAuthController.pkceParams` → `verifyMFA.execute`), not inside `/v2/login`, so the `mfa-required` error came back from `getLoginParams()` and propagated straight to the logger as `Login failed`. The MFA handler now wraps `getLoginParams` and, on `mfa-required`, prompts and re-calls `getLoginParams` with `{ [mfa_key]: code }` in the body — same flow the official server expects (cross-checked against `standardnotes/server` and `jonhadfield/gosn-v2`). Reported by @Adaluin in #3.
- Decrypted-content `JSON.parse` sites are now wrapped with a named-error helper. The plaintext is AEAD-authenticated (XChaCha20-Poly1305) so a corrupt-by-attacker case is impossible — but a genuinely malformed item would have surfaced as an opaque `SyntaxError`. The helper names the item kind and uuid, so the per-item `catch` in `fullSync` can skip it cleanly.

### Added

- `SECURITY.md` documenting the project's security posture (libsodium-only crypto, RAM-only password, OS-keychain session storage, stdio-only transport, redacted logs, zod input validation, TLS pinning) and an explicit accounting of the moderate `npm audit` advisories that surface through `@modelcontextprotocol/sdk`'s unused HTTP/SSE transport. Linked from the README.

## [0.3.4] — 2026-05-25

### Fixed

- Login against the official Standard Notes cloud (`api.standardnotes.com`) was failing for everyone with `HTTP 400 — Your client version is no longer supported. Please update Standard Notes to the latest version.` Around 2026-05 the SN api-gateway began rejecting any request that doesn't advertise a supported client version via the `X-SNJS-Version` and `X-Application-Version` headers — it gates on those headers, not the request body's `api` field. `snFetch` now sends both on every request. These version strings are hard-coded (see the comment in `src/sn/http.ts`) and will need bumping whenever the gateway raises its minimum again.
- Auth-endpoint errors are now surfaced correctly. Standard Notes returns auth errors (`/v2/login`, `/v2/login-params`) at the JSON top level (`{"error": …}`), whereas the sync endpoint nests them under `data`. `snFetch` only inspected `data.error`, so every auth failure collapsed to an opaque `HTTP <status>` — and, worse, `mfa-required` was never detected, meaning 2FA accounts could never complete an interactive login. The parser now reads both shapes, prompts for the 2FA code when required, and appends a redacted body snippet when the server returns an otherwise message-less error.

## [0.3.3] — 2026-05-11

### Fixed

- Claude Desktop (and any MCP host that resumes from a stored session) now boots correctly. Before, the persisted `sync_token` was reused on every cold boot, so the next incremental sync returned only changed items and skipped the (stable) `items_keys`, causing a `No items_key decrypted — likely wrong password or account not on protocol 004.` error even with a perfectly valid session. `createClientFromSession` now ignores the stored sync token and forces a full sync on cold boot (incremental syncs at runtime still use the live token).

### Added

- `mcp-standardnotes-install` CLI: writes/updates `claude_desktop_config.json` (macOS / Windows) with the correct absolute Node and binary paths, picks `SN_EMAIL` from the keychain when there's exactly one stored session, backs up any existing config before overwriting. `mcp-standardnotes-install code` prints the equivalent `claude mcp add` invocation for Claude Code. `mcp-standardnotes-login` now offers to run the Desktop install at the end of a successful login.

## [0.3.2] — 2026-05-11

### Fixed

- Login through the official Standard Notes API (`api.standardnotes.com`) — Cloudflare now serves a JS challenge to any HTTP/1.1 client regardless of User-Agent. The HTTP layer now negotiates HTTP/2 via `undici`'s `Agent({ allowH2: true })` and sends browser-like headers (Chrome UA, plus `Origin`/`Referer` scoped to the official host so self-hosted servers aren't affected). An `X-Client: mcp-standardnotes/<version>` header keeps the real client identifiable to Standard Notes' backend.
- `npm run login` no longer overwrites the `Password:` prompt label with a `*`. The CLI now uses raw-mode stdin for masked input instead of the brittle `readline._writeToOutput` hook.
- The `Login failed` error now surfaces the underlying `err.cause` chain and, on non-JSON responses, includes a redacted snippet of the response body — `fetch failed` mysteries become diagnosable instead of opaque.

### Changed

- Pinned `undici` to `^7.25.0` (was `^8.1.0`). `undici@8` requires Node `>=22.19` which broke the Node 20 CI matrix and would have broken Node 20 users in production. `undici@7` keeps `engines.node: >=20` honest.
- `fetch` is now imported directly from `undici` rather than the Node global, so the project-bundled `Agent` and `fetch` stay version-aligned regardless of which `undici` version Node ships internally.

### Security

- Added `overrides.fast-uri: ^3.1.2` in `package.json` to patch a HIGH-severity advisory (GHSA-q3j6-qgpj-74h6, path traversal via percent-encoded dot segments) coming transitively through `@modelcontextprotocol/sdk → ajv → fast-uri`.

## [0.3.1] — 2026-04-17

### Added

- `mcpName` field in `package.json` and a `server.json` at the repo root, for publication to the official MCP Registry (`registry.modelcontextprotocol.io`) under the namespace `io.github.lozit/mcp-standardnotes`.

## [0.3.0] — 2026-04-16

### Added

- `notes_create_many` tool: batch-create up to 50 notes in a single sync push.
- `notes_stats` tool: vault counts (total/active/trashed), tag count, breakdown by `noteType`, total/avg text bytes, oldest/newest/largest note.
- `notes_list` accepts an optional `tag` filter (UUID or title, case-insensitive).
- TLS certificate pinning for self-hosted servers via `SN_CERT_FINGERPRINT`.
- `npm run logout` CLI to wipe the keychain entry.
- `docs/self-hosted.md` walkthrough for self-hosting Standard Notes server.
- `docs/protocol-004.md` deep-dive: threat model, what's reimplemented locally vs. what comes from libsodium.
- `docs/troubleshooting.md` consolidated.
- `CONTRIBUTING.md`.
- GitHub Actions CI: typecheck + lint + test on Node 20/22, plus `npm audit`.

### Changed

- Sync token now persists in the OS keychain so restarts only fetch deltas.
- Default items_key is now the one with the highest `updated_at_timestamp` (matches the official SN app's choice after a key rotation).
- `notes_update` retries once on `sync_conflict` after refreshing the local raw record from the server's `server_item`.
- HTTP 401 mid-session triggers an automatic `refreshSession` + retry, with the new tokens persisted.
- HTTP 429 surfaces as a clear `SnApiError` with `retry-after` if the server provides it (no auto-retry).
- Trash branch of `notes_delete` now propagates the server's `updated_at` into the local cache.
- MFA UX: clearer prompt, validation of empty input, friendly error when no prompt is wired (e.g. inside the MCP runtime).
- `editorIdentifier` extracted to a constant; only set for editors with stable IDs (`markdown`, `super`, `code`).
- README split into landing + linked deep-dives.
- Relicensed from AGPL-3.0-or-later to MIT.
- All internal docs (`CLAUDE.md`, `.claude/rules/`) translated to English.

### Removed

- `src/cli/diag.ts` (experimental crypto probing, no longer needed).

## [0.2.0] — 2026-04-15

### Added

- Full tag CRUD: `tags_list`, `tags_get`, `tags_create`, `tags_update`, `tags_delete`, `tags_attach`, `tags_detach`.
- `notes_create` and `notes_update` accept an optional `tags: string[]` (tag UUIDs).
- `sync` tool exposed; returns decrypted note/tag counts.

### Fixed

- Note responses now include the tag titles linked to each note (previously hardcoded to `[]`).

## [0.1.0] — 2026-04-15

### Added

- Initial MCP server with notes CRUD (`notes_list`, `notes_search`, `notes_get`, `notes_create`, `notes_update`, `notes_delete`).
- Standard Notes protocol 004 framing (Argon2id + XChaCha20-Poly1305 IETF via `libsodium-wrappers-sumo`).
- Interactive login via `npm run login`; session persisted in OS keychain (`keytar`).
- Logger with secret redaction (`src/security/redact.ts`).
- stdio transport only.
