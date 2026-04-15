# Security rules

<important if="tout changement touchant auth, crypto, logging, stockage, ou réseau">
- Jamais de `console.log` sur stdout (casse MCP stdio). Utiliser stderr.
- Jamais logger ou persister : password, rootKey, masterKey, serverPassword, itemsKey, JWT, session token.
- Toujours passer par `security/redact.ts` avant tout log.
- Jamais écrire de secret dans `.env` — utiliser le keychain OS via `keytar`.
- Jamais ajouter un transport réseau au serveur MCP (stdio only).
- Jamais désactiver la vérification TLS (`rejectUnauthorized: false` interdit).
- Toute entrée tool MCP validée par zod avant usage.
- `npm audit` HIGH/CRITICAL = blocker.
</important>
