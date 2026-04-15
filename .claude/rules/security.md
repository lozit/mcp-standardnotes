# Security rules

<important if="any change touching auth, crypto, logging, storage, or network">
- Never `console.log` to stdout (breaks MCP stdio). Use stderr.
- Never log or persist: password, rootKey, masterKey, serverPassword, itemsKey, JWT, session token.
- Always route through `security/redact.ts` before any log.
- Never write a secret to `.env` — use the OS keychain via `keytar`.
- Never add a network transport to the MCP server (stdio only).
- Never disable TLS verification (`rejectUnauthorized: false` is forbidden).
- Every MCP tool input is validated by zod before use.
- `npm audit` HIGH/CRITICAL = blocker.
</important>
