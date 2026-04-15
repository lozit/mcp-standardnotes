# Roadmap

Tracking what's left to implement. Items are ordered roughly by priority, not by ease.

## Protocol coverage

- [x] **Tags** — full CRUD (`tags_list`, `tags_get`, `tags_create`, `tags_update`, `tags_delete`, `tags_attach`, `tags_detach`), plus `tags` param on `notes_create`/`notes_update`.
- [x] **Force-sync tool** — `sync` exposed; returns note/tag counts.
- [x] **Tag-filtered list** — `notes_list` accepts an optional `tag` (UUID or title, case-insensitive).
- [ ] **Pagination cursors for large accounts** — current `notes_list` walks the full decrypted cache in memory. Fine for <10k notes, not great beyond.

## Auth / session

- [x] **Wire up session refresh.** `callSync` in `src/sn/client.ts` now detects 401, calls `refreshSession`, persists the new tokens to keychain, and retries once.
- [ ] **Rate-limit handling** — surface 429 cleanly (don't retry in a loop).
- [x] **Logout command** — `npm run logout` (or `npm run logout -- <email>`) wipes the keychain entry.
- [ ] **MFA UX in CLI** — the login flow supports MFA via the `mfaPrompt` callback, but `src/cli/login.ts` re-prompts on stdin; worth improving the error message when MFA is required but no prompt is wired.

## Crypto features

- [ ] **Signing for shared vaults.** Payloads in shared vaults require an Ed25519 `signingData` in the 5th payload field. Personal notes don't need it (`doesPayloadRequireSigning` checks `shared_vault_uuid`). Skipping this means shared-vault items won't be writable from the MCP.
- [ ] **Items-key rotation.** Currently picks the first `SN|ItemsKey` as default. If the user has multiple (e.g. after a key rotation), we should use the most recent. Not strictly a bug — any items_key can decrypt any item that was wrapped under it — but cosmetically wrong and would affect app compatibility if we ever write items_keys ourselves.
- [x] **TLS certificate pinning** via `SN_CERT_FINGERPRINT`. Wired through an `undici` Agent with `checkServerIdentity` comparing the SHA-256 fingerprint of the leaf cert.

## Write path hardening

- [x] **Trash branch of `deleteNote`** — saved timestamps now propagated into `state.notesCache`.
- [x] **Conflict resolution on `notes_update`.** On `sync_conflict`, refresh the local raw record from `server_item` and retry once. Surface a clear error if it still conflicts.
- [ ] **Note types beyond markdown.** `noteType` enum is already defined; `super` has text normalization; the others (`code`, `rich-text`, `task`, `spreadsheet`, `authentication`) work for creation but we don't set the right `editorIdentifier` for all of them.

## Quality

- [ ] **Unit tests** for `src/security/redact.ts` (secret masking), zod schema edge cases, protocol-004 parse/unparse round-trips.
- [ ] **Integration tests** against a self-hosted Standard Notes server via `docker-compose`. Must never point at the production SN server from CI.
- [x] **CI pipeline** (GitHub Actions): `typecheck`, `lint`, `test`, `audit` on push/PR.
- [x] **Lint cleanup** — `diag.ts` removed (no longer needed).

## Open-source polish

- [x] **Translate all French to English.** `CLAUDE.md` and `.claude/rules/security.md` are now in English.
- [x] **Relicense to MIT.** Switched from AGPL-3.0-or-later to MIT for broader adoption.
- [x] **Split "user-facing" docs from "contributor" docs.** Landing README, `CONTRIBUTING.md`, `docs/protocol-004.md`, `docs/troubleshooting.md`. `CLAUDE.md` + `.claude/` stay public.

## Documentation

- [x] **Self-hosted server walkthrough.** See [`docs/self-hosted.md`](./docs/self-hosted.md).
- [ ] **Security whitepaper annex** explaining exactly what's reimplemented locally (framing only) vs. what comes from libsodium (all crypto primitives). Useful for auditors and skeptical users.

## Nice-to-have

- [ ] Batch create (array of notes in a single sync push).
- [ ] Incremental sync between invocations (persist `sync_token` in the keychain blob so restarts don't refetch everything).
- [ ] Optional `SN_SESSION_FILE` override for testing (plaintext JSON session file, never the default — must be explicitly opt-in).
- [x] `notes_stats` tool — counts (total/active/trashed), tags, byNoteType, total/avg text bytes, oldest/newest/largest note.

## Explicitly out of scope

- **Network transport.** stdio only. See `CLAUDE.md` §3 and `.claude/rules/security.md`. Remote/HTTP would require rewriting the security model, TLS, auth, rate-limiting — and isn't worth it for a tool this personal. Users wanting mobile access should keep using the official SN app.
- **Reimplementing any cryptographic primitive.** All primitives come from `libsodium-wrappers-sumo`. We only parse/serialize the protocol 004 framing.
- **Legacy 003 accounts.** Rejected at login with a clear error. Upgrade via the official app.
