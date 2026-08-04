# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] — 2026-08-04

### Fixed

- Login against `api.standardnotes.com` was starting to fail with HTTP 403 `cf-mitigated: challenge` (`Non-JSON response ... Just a moment ...`). Between v0.3.2 and v0.5.0 the client sent a Chrome User-Agent plus `Origin`/`Referer` to slip past Cloudflare's JS challenge; that gambit is now counter-productive — CF cross-checks UA against TLS fingerprint and scores "claims to be Chrome, non-browser handshake" as impersonation, blocking it harder than honest non-browser clients. Reverted to an honest `mcp-standardnotes/<version>` User-Agent with no `Origin`/`Referer` injection. Reproduced from a residential IP on 2026-08-04, matching the datacenter report in [issue #6](https://github.com/lozit/mcp-standardnotes/issues/6). HTTP/2 negotiation (`allowH2`) and the `X-SNJS-Version` / `X-Application-Version` gate headers are unchanged.

### Security

- Bumped `undici` to `^7.29.0` (runtime dep) to clear five HIGH advisories: response desynchronization via retry interceptor (GHSA-8xcm-r25x-g524), cross-user info disclosure via private-cache directives (GHSA-4cwx-7wf7-3272), CRLF injection via blob body (GHSA-m8rv-5g2x-5cg5), Cache-Control whitespace desync (GHSA-jr45-8vmc-qm54), cookie attribute injection (GHSA-v3r7-h72x-cjcm).
- Added `overrides` for transitive HIGH advisories: `brace-expansion` `^2.1.4` (GHSA-mh99-v99m-4gvg, unbounded expansion OOM crash — replaces the branch-scoped overrides added in v0.4.1), `ip-address` `^10.4.0` (GHSA-mwp4-54f8-5fhr, Address4 leading-zero SSRF; GHSA-v2v4-37r5-5v8g, Address6 XSS), `postcss` `^8.5.23` (GHSA-r28c-9q8g-f849 + GHSA-fxqj-rqcc-2cmp, path traversal via sourceMappingURL — devDep transitive only). Bumped existing `fast-uri` (`^3.1.5`, GHSA-v2hh-gcrm-f6hx / -4c8g-83qw-93j6 / -7p8r-x3mc-p8w7 host confusion) and `hono` (`^4.12.34`) overrides.

## [0.5.0] — 2026-07-21

### Added

- `notes_list` accepts an optional `includeDescendants: boolean` (default `false`). When filtering by tag, setting it to `true` also returns notes filed under any child, grandchild, etc. — same behavior as clicking a folder in the SN sidebar. Existing callers are unaffected. Useful for the "knowledge base" pattern where the parent tag is an empty container and every note lives on a descendant (see [issue #5](https://github.com/lozit/mcp-standardnotes/issues/5) discussion). Backed by a new `subtreeTagUuids` helper in `src/sn/tagHierarchy.ts` (BFS, defensive against pre-existing vault cycles).

## [0.4.0] — 2026-07-19

### Added

- Nested tags (SN "folders") are now readable and writable through MCP. `tags_list` and `tags_get` surface `parentUuid` (null for top-level tags); `tags_create` accepts an optional `parent` UUID; `tags_update` accepts `parent: <uuid>` to re-parent and `parent: null` to detach. Cycles (self-parent, ancestor loop) and missing parents are rejected. The duplicate-title check is now scoped to siblings under the same parent, matching the SN app's semantics — you can have `work/notes` and `personal/notes` side by side. Wire format: a `{ uuid: <parent>, content_type: "SN|Tag", reference_type: "TagToParentTag" }` reference on the child (see `docs/protocol-004.md`). Fixes lozit/mcp-standardnotes#5.

## [0.3.7] — 2026-07-10

### Fixed

- Login against the official Standard Notes cloud (`api.standardnotes.com`) was failing again with `Non-JSON response ... 403 ... Just a moment ...` (`cf-mitigated: challenge`). Cloudflare's UA fingerprint ages out — our Chrome/131 UA had gone stale enough to be flagged as bot-like. Bumped `BROWSER_UA` to Chrome/145. Same class of gate as 0.3.2 (HTTP/2 negotiation + browser headers) — expect to have to bump the Chrome major every so often as CF's floor rises. Comment on `BROWSER_UA` calls out the symptom and the fix.

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
