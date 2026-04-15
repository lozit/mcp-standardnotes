# Roadmap

Tracking what's left to implement. Items are ordered roughly by priority, not by ease.

## Protocol coverage

- [ ] **Tags** — `tags_list`, `tags_create`, attach/detach tags on notes. `tags_list` is mentioned in `CLAUDE.md` but not yet registered in `src/server.ts`. Schema already exists server-side (`content_type: "Tag"`).
- [ ] **Force-sync tool** — expose `sync` as an MCP tool so the LLM can explicitly refresh state after external changes.
- [ ] **Tag-filtered list** — `notes_list` option to filter by tag uuid/name.
- [ ] **Pagination cursors for large accounts** — current `notes_list` walks the full decrypted cache in memory. Fine for <10k notes, not great beyond.

## Auth / session

- [ ] **Wire up session refresh.** `refreshSession()` exists in `src/sn/http.ts` but is never called. When access_token expires mid-session, the next request fails hard. Need: detect 401, refresh, retry once, update keychain.
- [ ] **Rate-limit handling** — surface 429 cleanly (don't retry in a loop).
- [ ] **Logout command** — `npm run logout` to wipe the keychain entry cleanly (currently requires manual `security delete-generic-password`).
- [ ] **MFA UX in CLI** — the login flow supports MFA via the `mfaPrompt` callback, but `src/cli/login.ts` re-prompts on stdin; worth improving the error message when MFA is required but no prompt is wired.

## Crypto features

- [ ] **Signing for shared vaults.** Payloads in shared vaults require an Ed25519 `signingData` in the 5th payload field. Personal notes don't need it (`doesPayloadRequireSigning` checks `shared_vault_uuid`). Skipping this means shared-vault items won't be writable from the MCP.
- [ ] **Items-key rotation.** Currently picks the first `SN|ItemsKey` as default. If the user has multiple (e.g. after a key rotation), we should use the most recent. Not strictly a bug — any items_key can decrypt any item that was wrapped under it — but cosmetically wrong and would affect app compatibility if we ever write items_keys ourselves.
- [ ] **TLS certificate pinning** for self-hosted servers via `SN_CERT_FINGERPRINT` env var. Stub documented in README; not implemented.

## Write path hardening

- [ ] **Trash branch of `deleteNote`** — already writes the trashed note back, but doesn't propagate the server's returned timestamps into `state.notesCache`. Minor cosmetic issue (trashed note's `updatedAt` in local cache is slightly off until next full sync).
- [ ] **Conflict resolution on `notes_update`.** Today we throw if the server returns a conflict. Better: fetch the remote version, merge, retry — or at minimum surface a structured error the LLM can react to.
- [ ] **Note types beyond markdown.** `noteType` enum is already defined; `super` has text normalization; the others (`code`, `rich-text`, `task`, `spreadsheet`, `authentication`) work for creation but we don't set the right `editorIdentifier` for all of them.

## Quality

- [ ] **Unit tests** for `src/security/redact.ts` (secret masking), zod schema edge cases, protocol-004 parse/unparse round-trips.
- [ ] **Integration tests** against a self-hosted Standard Notes server via `docker-compose`. Must never point at the production SN server from CI.
- [ ] **CI pipeline** (GitHub Actions): `typecheck`, `lint`, `test`, `audit`. Fail build on `npm audit` HIGH/CRITICAL per the security rules.
- [ ] **Lint cleanup** — `diag.ts` has a lot of experimental crypto probing that can now be removed since protocol 004 is understood.

## Documentation

- [ ] **Self-hosted server walkthrough.** Docker-compose recipe + how to point `SN_SERVER_URL` at it + a step-by-step first-run.
- [ ] **Security whitepaper annex** explaining exactly what's reimplemented locally (framing only) vs. what comes from libsodium (all crypto primitives). Useful for auditors and skeptical users.

## Nice-to-have

- [ ] Batch create (array of notes in a single sync push).
- [ ] Incremental sync between invocations (persist `sync_token` in the keychain blob so restarts don't refetch everything).
- [ ] Optional `SN_SESSION_FILE` override for testing (plaintext JSON session file, never the default — must be explicitly opt-in).
- [ ] `notes_stats` tool (count, total size, last-modified) for when the LLM wants to reason about account shape without paging everything.

## Explicitly out of scope

- **Network transport.** stdio only. See `CLAUDE.md` §3 and `.claude/rules/security.md`. Remote/HTTP would require rewriting the security model, TLS, auth, rate-limiting — and isn't worth it for a tool this personal. Users wanting mobile access should keep using the official SN app.
- **Reimplementing any cryptographic primitive.** All primitives come from `libsodium-wrappers-sumo`. We only parse/serialize the protocol 004 framing.
- **Legacy 003 accounts.** Rejected at login with a clear error. Upgrade via the official app.
