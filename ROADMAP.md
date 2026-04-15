# Roadmap

Tracking what's left to implement. Items are ordered roughly by priority, not by ease.

## Protocol coverage

- [x] **Tags** — full CRUD (`tags_list`, `tags_get`, `tags_create`, `tags_update`, `tags_delete`, `tags_attach`, `tags_detach`), plus `tags` param on `notes_create`/`notes_update`.
- [x] **Force-sync tool** — `sync` exposed; returns note/tag counts.
- [x] **Tag-filtered list** — `notes_list` accepts an optional `tag` (UUID or title, case-insensitive).
- [ ] **Pagination cursors for large accounts** — current `notes_list` walks the full decrypted cache in memory. Fine for <10k notes; deferred until a user reports it bites.

## Auth / session

- [x] **Wire up session refresh.** `callSync` in `src/sn/client.ts` now detects 401, calls `refreshSession`, persists the new tokens to keychain, and retries once.
- [x] **Rate-limit handling** — `snFetch` raises a clear `SnApiError` (tag `rate-limited`) on HTTP 429, with `retry-after` if the server sends it. No auto-retry.
- [x] **Logout command** — `npm run logout` (or `npm run logout -- <email>`) wipes the keychain entry.
- [x] **MFA UX in CLI** — clearer prompt ("Two-factor code (6 digits)"), validation of empty input, and a friendly error when MFA is required but no prompt is wired (i.e. MCP runtime, not the interactive CLI).

## Crypto features

- [ ] **Signing for shared vaults.** Payloads in shared vaults require an Ed25519 `signingData` in the 5th payload field. Personal notes don't need it (`doesPayloadRequireSigning` checks `shared_vault_uuid`). Skipping this means shared-vault items won't be writable from the MCP.
- [x] **Items-key rotation.** `defaultItemsKeyUuid` is now the items_key with the highest `updated_at_timestamp`.
- [x] **TLS certificate pinning** via `SN_CERT_FINGERPRINT`. Wired through an `undici` Agent with `checkServerIdentity` comparing the SHA-256 fingerprint of the leaf cert.

## Write path hardening

- [x] **Trash branch of `deleteNote`** — saved timestamps now propagated into `state.notesCache`.
- [x] **Conflict resolution on `notes_update`.** On `sync_conflict`, refresh the local raw record from `server_item` and retry once. Surface a clear error if it still conflicts.
- [x] **Note types beyond markdown.** Editor identifiers extracted to a constant; `markdown`/`super`/`code` set well-known IDs; the others intentionally omit `editorIdentifier` because modern SN routes by `noteType` alone and a wrong identifier would mask the type.

## Quality

- [x] **Unit tests** for `src/security/redact.ts` (secret masking), zod schema edge cases, protocol-004 parse/unparse round-trips. 41 tests in 6 files.
- [ ] **Integration tests** against a self-hosted Standard Notes server via `docker-compose`. Must never point at the production SN server from CI.
- [x] **CI pipeline** (GitHub Actions): `typecheck`, `lint`, `test`, `audit` on push/PR.
- [x] **Lint cleanup** — `diag.ts` removed (no longer needed).

## Open-source polish

- [x] **Translate all French to English.** `CLAUDE.md` and `.claude/rules/security.md` are now in English.
- [x] **Relicense to MIT.** Switched from AGPL-3.0-or-later to MIT for broader adoption.
- [x] **Split "user-facing" docs from "contributor" docs.** Landing README, `CONTRIBUTING.md`, `docs/protocol-004.md`, `docs/troubleshooting.md`. `CLAUDE.md` + `.claude/` stay public.

## Documentation

- [x] **Self-hosted server walkthrough.** See [`docs/self-hosted.md`](./docs/self-hosted.md).
- [x] **Security whitepaper annex** — see [`docs/protocol-004.md`](./docs/protocol-004.md), which spells out the threat model, what's reimplemented locally (framing only), and what comes from `libsodium-wrappers-sumo` (every primitive).

## Nice-to-have

- [x] Batch create — `notes_create_many` (up to 50 notes per call, single sync push).
- [x] Incremental sync between invocations — `sync_token` persisted in the keychain blob; deleted items propagated through caches on retrieved.
- [ ] Optional `SN_SESSION_FILE` override for testing (plaintext JSON session file, never the default — must be explicitly opt-in).
- [x] `notes_stats` tool — counts (total/active/trashed), tags, byNoteType, total/avg text bytes, oldest/newest/largest note.

## Explicitly out of scope

- **Network transport.** stdio only. See `CLAUDE.md` §3 and `.claude/rules/security.md`. Remote/HTTP would require rewriting the security model, TLS, auth, rate-limiting — and isn't worth it for a tool this personal. Users wanting mobile access should keep using the official SN app.
- **Reimplementing any cryptographic primitive.** All primitives come from `libsodium-wrappers-sumo`. We only parse/serialize the protocol 004 framing.
- **Legacy 003 accounts.** Rejected at login with a clear error. Upgrade via the official app.
