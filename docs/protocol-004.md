# Standard Notes protocol 004 — how it works here

This document explains what parts of the protocol this server implements locally, and what it deliberately does *not* reimplement.

## Threat model & security guarantees

- **Your password** is only used in RAM to derive the root key (Argon2id). It is never logged, never written to disk, never sent to the server (only the derived `serverPassword` hex is, over TLS).
- **Your master key** is derived locally and stays on your machine. It's stored (hex-encoded) in the OS keychain alongside the session token — never in a plaintext file.
- **All note content** is decrypted *locally*. The server only ever sees ciphertext.
- **Transport is stdio only.** This process opens no network port. If a future maintainer proposes adding an HTTP transport, the answer is no — `CLAUDE.md` documents why.
- **Destructive ops require explicit flags.** `notes_delete { permanent: true }` is not a default.
- **All tool inputs are validated by `zod`** (UUID format, 10 MB max content length, etc.).
- **All logs are routed through `src/security/redact.ts`** which masks passwords, master keys, items_keys, JWTs, and any string that looks like a long token. Stdout is reserved for the MCP protocol; logs go to stderr.
- **Dependencies** are monitored: `npm audit` HIGH/CRITICAL is a merge blocker in CI.

Full security rules live in [`.claude/rules/security.md`](../.claude/rules/security.md).

## What's reimplemented locally (framing only)

Only the **parsing and serialization** of Standard Notes' public, documented protocol 004 format:

- Payload string format: `004:<nonce_hex>:<ciphertext_b64>:<aad_b64>:<additional_data_b64>`
- Root key derivation (Argon2id with fixed SN parameters: ops=5, mem=64MB, 64-byte output split into masterKey + serverPassword)
- `SN|ItemsKey` unwrap: each items_key is itself encrypted under the root key; decrypting it yields the symmetric key used to decrypt notes and tags
- Per-item key wrapping: each note/tag uses a fresh random `perItemKey`; the content is AEAD-encrypted under `perItemKey`, and `perItemKey` itself is AEAD-encrypted under the items_key
- AAD construction: JSON `{u: item_uuid, v: "004"}` for notes/tags; `{u, v, kp: keyParams}` only for items_keys under the root key (the extra `kp` on regular items causes the official SN app to silently drop them)

## What comes from `libsodium-wrappers-sumo`

Every single cryptographic primitive:

- **Argon2id** for key derivation
- **XChaCha20-Poly1305 IETF** (AEAD) for all encryption/decryption
- SHA-256 for salt construction
- Secure random bytes for nonces and per-item keys
- Hex/base64 encoding helpers

No AES, no ChaCha, no KDF, no HMAC, no signing is written by hand in this repo.

## One-paragraph walkthrough

At login: `Argon2id(password, salt = sha256(email:pw_nonce)[:16], ops=5, mem=64MB)` → 64 bytes split into `masterKey` (first 32) and `serverPassword` (last 32, hex). `serverPassword` is sent to `/v2/login` with a PKCE code verifier; `masterKey` stays local. The server returns an access_token plus a list of `SN|ItemsKey` items encrypted under `masterKey`. Each items_key (K) is used to encrypt notes and tags: a per-item random key K' is generated, the content is AEAD-encrypted under K' (XChaCha20-Poly1305 IETF), and K' itself is AEAD-encrypted under K. Payloads are serialized as `004:<nonce_hex>:<ciphertext_b64>:<aad_b64>:<additional_data_b64>`. The AAD is the UTF-8 bytes of the base64-encoded `{u: item_uuid, v: "004"}` JSON object. Signing (Ed25519 over plaintext hash) is required only for items in shared vaults; personal items use `{}` for `additional_data`.

## Deliberately out of scope

- **Reimplementing any cryptographic primitive.** All primitives come from `libsodium-wrappers-sumo`. We only parse/serialize the protocol 004 framing.
- **Legacy protocol 003** accounts. Rejected at login with a clear error. Upgrade via the official Standard Notes app.
- **Network transport** for the MCP server (HTTP/WebSocket/etc.). stdio only. Users wanting mobile access should keep using the official Standard Notes app.

## References

- Standard Notes [encryption whitepaper](https://standardnotes.com/help/security/encryption)
- SNJS [specification](https://github.com/standardnotes/snjs/blob/main/packages/snjs/specification.md)
- Source: [`src/sn/protocol004.ts`](../src/sn/protocol004.ts)
