# MCP Standard Notes

Serveur MCP (Model Context Protocol) permettant à Claude d'interagir avec un compte Standard Notes (lecture, création, édition, suppression de notes et tags) tout en respectant le chiffrement de bout en bout (E2EE) de Standard Notes.

<important if="travail sur le chiffrement ou l'authentification">
NE JAMAIS réimplémenter une primitive cryptographique à la main (pas d'AES, pas de ChaCha, pas de KDF custom). Les primitives viennent exclusivement de `libsodium-wrappers-sumo` (audité, Argon2id + XChaCha20-Poly1305 IETF).

Ce qui est implémenté localement = uniquement le **framing du protocole 004 Standard Notes** (format de payload `004:<nonce>:<ciphertext>:<aad>`, dérivation root key → masterKey/serverPassword, wrap/unwrap d'items_keys). C'est du parsing/sérialisation de format public documenté, pas de la cryptographie nouvelle.

Les paquets `@standardnotes/snjs` et modulaires `@standardnotes/{encryption,models,...}` ont été écartés : le monolithe est déprécié (Node 16 only), et les paquets modulaires ont des breaking changes non-propagés (ContentType retiré de common) qui les rendent inutilisables en externe.
</important>

## Stack

- **Language** : TypeScript (strict)
- **Runtime** : Node.js ≥ 20
- **SDK MCP** : `@modelcontextprotocol/sdk`
- **Crypto** : `libsodium-wrappers-sumo` (Argon2id + XChaCha20-Poly1305 IETF)
- **HTTP** : `fetch` natif (Node 20+)
- **Transport MCP** : stdio (local, pas d'exposition réseau)

## Commandes

```bash
npm install            # Installer les dépendances
npm run build          # Compiler TypeScript → dist/
npm run dev            # Lancer en watch mode (tsx)
npm run typecheck      # Vérifier les types sans build
npm test               # Lancer les tests (vitest)
npm run lint           # ESLint
```

## Structure

```
src/
  index.ts             # Entrée MCP stdio
  server.ts            # McpServer + registration des tools
  cli/login.ts         # `npm run login` — prompt interactif + keychain
  sn/
    client.ts          # Orchestration : login/session → HTTP + protocol
    crypto.ts          # Wrapper libsodium (argon2id, xchacha20poly1305)
    protocol004.ts     # Framing SN 004 : root key, items_key wrap, payload enc/dec
    http.ts            # fetch wrapper : /v1/login-params, /v1/login, /v1/items/sync
    session.ts         # Persistance session via keytar
    types.ts           # Types Note/NoteSummary/KeyParams
  tools/notes.ts       # Handlers MCP + zod schemas
  security/
    redact.ts, logger.ts
.env.example
```

## Tools MCP exposés

| Tool | Description |
|------|-------------|
| `notes_list` | Liste les notes (titre + uuid, contenu tronqué) |
| `notes_search` | Recherche full-text sur titre+contenu déchiffrés |
| `notes_get` | Récupère une note par uuid |
| `notes_create` | Crée une note (title, text, tags?) |
| `notes_update` | Met à jour une note existante |
| `notes_delete` | Supprime (trash par défaut, purge si `permanent=true`) |
| `tags_list` | Liste des tags |
| `sync` | Force une synchronisation |

## Exigences de sécurité (non négociables)

<important if="ajout/modification d'un tool, stockage, logging, ou auth">
1. **Mot de passe jamais loggé, jamais stocké.** Le password utilisateur n'apparaît ni en clair ni hashé dans les logs, fichiers, ou variables d'env persistantes. Il sert uniquement à dériver le root key via SNJS en mémoire.
2. **Stockage de session** : le token/session SNJS est stocké via `keytar` (Keychain macOS / libsecret Linux / Credential Vault Windows). JAMAIS dans un fichier plain-text sous `~/.config`.
3. **Transport stdio uniquement.** Pas de port HTTP ouvert. Si un transport réseau est demandé, refuser et expliquer le risque.
4. **Logs** : passer tout output par `security/redact.ts` qui masque les champs `password`, `mk`, `ak`, `pw`, `itemsKey`, `authKeyParams`, JWT, et toute string ressemblant à un token (>= 32 chars base64/hex).
5. **Validation d'entrée** : toutes les inputs des tools MCP validées par `zod`. UUID format strict, longueur max des contenus (10 MB).
6. **Confirmation destructrice** : `notes_delete` avec `permanent=true` DOIT exiger un flag explicite côté tool arg — pas de purge silencieuse.
7. **TLS cert pinning** pour serveurs auto-hébergés (optionnel, via env `SN_CERT_FINGERPRINT`).
8. **Pas de télémétrie.** Aucun appel réseau sortant en dehors du endpoint SN configuré.
9. **Dépendances** : `npm audit` doit passer sans vuln HIGH/CRITICAL avant tout merge.
</important>

## Configuration

Via variables d'environnement (voir `.env.example`) :

- `SN_SERVER_URL` — URL du serveur (default: `https://api.standardnotes.com`)
- `SN_EMAIL` — email du compte (le password est demandé au premier run puis la session est persistée chiffrée)
- `SN_CERT_FINGERPRINT` — (optionnel) pinning SHA-256 du cert TLS

Le premier démarrage déclenche un login interactif (prompt stdin hors MCP, via `npm run login`) qui stocke la session dans le keychain OS. Les runs suivants réutilisent la session.

## Gotchas

- **SNJS est async-heavy** : toujours `await application.sync()` après un CRUD avant de considérer l'opération terminée.
- **Conflits de sync** : SNJS peut créer des duplicatas en cas de conflit ; le tool `notes_update` doit récupérer la note fraîche avant write.
- **Protocole 003 legacy** : refuser les comptes non migrés 004 avec un message clair — pas de contournement.
- **Rate limiting** : le serveur SN rate-limit l'auth (5/min). Ne pas retry en boucle sur un 429.
- **MCP stdio** : tout `console.log` casse le protocole. Utiliser `console.error` pour les logs, ou un logger qui écrit sur stderr uniquement.

## Tests

- Tests unitaires : redaction, validation zod, parsing des réponses SN (mocked).
- Tests d'intégration : optionnels, contre un serveur SN self-hosted local (docker-compose). Jamais contre le serveur prod officiel en CI.
- **Ne jamais committer** de fixtures contenant de vraies données chiffrées ou des clés.

## Références

- Spec SNJS : https://github.com/standardnotes/snjs/blob/main/packages/snjs/specification.md
- Whitepaper crypto : https://standardnotes.com/help/security/encryption
- MCP SDK : https://github.com/modelcontextprotocol/typescript-sdk
