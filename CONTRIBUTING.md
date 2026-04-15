# Contributing

Thanks for your interest! This project is small and opinionated — please read the whole guide before opening your first PR.

## Ground rules

1. **Never commit fixtures containing real encrypted data or keys.** Not your account, not a test account.
2. **Security rules in [`.claude/rules/security.md`](.claude/rules/security.md) are non-negotiable.** Any change that touches auth, crypto, logging, storage, or network must respect them.
3. **`npm audit` HIGH/CRITICAL is a merge blocker.** CI enforces it.
4. **For cryptography-touching changes, open an issue first** to discuss scope. We do not reimplement primitives — everything comes from `libsodium-wrappers-sumo`.

## Setup

```bash
git clone https://github.com/lozit/mcp-standardnotes.git
cd mcp-standardnotes
npm install
```

## Commands

```bash
npm run dev         # watch mode (tsx)
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest run
npm run audit       # npm audit, fails on HIGH/CRITICAL
```

Additional dev CLIs under `src/cli/`:

- `npm run login` — interactive login, stores session in the OS keychain.
- `npm run logout` — wipe the keychain entry (reads `SN_EMAIL` or `npm run logout -- <email>`).
- `npm run dump-note -- <uuid-or-title>` — decrypt and print a note's raw content JSON + server item fields (useful when debugging payload compatibility with the official SN app).

## PR checklist

Before opening a PR:

```bash
npm run typecheck && npm run lint && npm test && npm run audit
```

Then:

- Keep changes focused. If you find an unrelated bug, open a separate PR.
- For new MCP tools: add a zod schema, register in `src/server.ts`, add at least one input-validation test.
- For changes to the sync/write path: verify round-trip against the official Standard Notes app (notes you create/update via MCP must be readable and un-corrupted in the app).
- For protocol 004 changes: read [docs/protocol-004.md](./docs/protocol-004.md) first.

## Project layout

```
src/
  index.ts              # MCP stdio entry point
  server.ts             # McpServer + tool registration
  cli/
    login.ts            # `npm run login`
    dump-note.ts        # decrypt-and-print for debugging
  sn/
    client.ts           # Orchestration: login/session → HTTP + protocol
    crypto.ts           # Thin wrapper over libsodium
    protocol004.ts      # Framing: root key derivation, items_key decryption, note/tag enc/dec
    http.ts             # fetch wrapper for /v2/login-params, /v2/login, /v1/items
    session.ts          # Keychain persistence via keytar
    types.ts            # Note / NoteSummary / NoteType / Tag / TagSummary
  tools/
    notes.ts            # Notes MCP handlers + zod schemas
    tags.ts             # Tags + sync MCP handlers + zod schemas
  security/
    redact.ts           # Redacts secrets from any object before logging
    logger.ts           # stderr-only logger using redact
```

## Testing

Unit tests live alongside the code they test (`*.test.ts`). Write tests for:

- Input validation (zod schemas must reject malformed inputs).
- Encryption round-trips when touching `protocol004.ts`.
- Redaction rules when touching `redact.ts`.

Integration tests against a self-hosted Standard Notes server (docker-compose) are welcome. **Never point CI at the production SN server.**

## Commit style

- Present-tense, imperative ("Add X", "Fix Y"), lowercase after the verb is fine.
- Body explains *why*, not *what* (the diff shows *what*).
- Reference issues in the body when applicable.

## Releasing

Not yet. This repo is pre-1.0. When we cut a release it'll be `npm publish` + a GitHub release from a tagged commit on `main`.
