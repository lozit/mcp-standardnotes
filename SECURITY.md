# Security Policy

`mcp-standardnotes` gives an AI assistant end-to-end-encrypted access to a
Standard Notes vault. Security is the whole point of the project, so this
document states the posture explicitly and explains how to report problems.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/lozit/mcp-standardnotes/security/advisories/new)
(the *Security → Advisories* tab on the repository). Include the version, your
platform, and a minimal reproduction.

Expect an acknowledgement within a few days. Confirmed issues are fixed on a
priority basis, released as a patch version, and credited in the changelog
unless you ask otherwise.

## Supported versions

Only the latest published `0.3.x` release receives security fixes. There is no
back-porting to older lines while the project is pre-1.0.

| Version | Supported |
|---------|-----------|
| latest `0.3.x` | ✅ |
| older | ❌ |

## Security posture

- **End-to-end encryption is preserved.** All cryptographic primitives come
  from `libsodium-wrappers-sumo` (audited Argon2id + XChaCha20-Poly1305 IETF).
  Only the Standard Notes protocol 004 *framing* is implemented locally — no
  hand-rolled crypto. See [docs/protocol-004.md](./docs/protocol-004.md) for the
  threat model.
- **The password lives in RAM only**, during key derivation. It is never
  logged, never written to disk, never stored in an environment variable.
- **Secrets go to the OS keychain only** (`keytar` → macOS Keychain / Linux
  libsecret / Windows Credential Vault). The session token and master-key hex
  are never written to plaintext files.
- **stdio transport only.** The server opens no network port and accepts no
  remote connections. The only outbound traffic is to the configured Standard
  Notes sync endpoint.
- **Logs are redacted.** Everything is written to stderr through
  `src/security/redact.ts`, which masks passwords, keys, JWTs, and any
  token-like string.
- **All tool inputs are validated by `zod`** (strict UUIDs, content-size caps),
  and `notes_delete` requires an explicit flag for a permanent purge.
- **TLS verification is never disabled**; self-hosted servers can additionally
  be pinned with `SN_CERT_FINGERPRINT`.

## Dependency advisories

`npm audit` on the published package reports **no HIGH or CRITICAL
vulnerabilities** — the project's CI treats any HIGH/CRITICAL as a merge
blocker. A small number of **moderate** advisories may surface in third-party
scanners; here is the full, honest accounting so the report isn't a mystery:

- **`express`, `express-rate-limit`, `qs`, `ip-address`, `hono` (moderate).**
  These are pulled in transitively by `@modelcontextprotocol/sdk` for its
  **HTTP/SSE server transport**. This project is **stdio-only** and never
  instantiates that transport, so the affected code is never loaded and there
  is no exploit path in normal use. They will clear once the upstream SDK
  drops or optionalises those dependencies; the SDK is already kept at its
  latest release.
- **`vitest`, `eslint` and other build tooling.** These are `devDependencies`.
  They are used only to build and test the project and are **not included in the
  published npm package** (only `dist/` and docs ship — see the `files` field in
  `package.json`). They cannot affect an installed copy.

> **Note on `overrides`.** npm only honours a package's `overrides` field for the
> project where it is the *root*. They do **not** propagate to consumers who
> install `mcp-standardnotes` as a dependency. The `overrides` in this repo
> therefore harden our own CI/build tree; they are not a substitute for upstream
> fixes in the resolved dependency tree of an end user. The real lever for the
> transitive moderates above is the upstream SDK, which we track.

If you believe one of these *is* reachable in this project's stdio-only usage,
that is exactly the kind of report we want — please file it privately via the
link above.
