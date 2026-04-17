# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
