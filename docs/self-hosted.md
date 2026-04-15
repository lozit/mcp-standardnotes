# Using mcp-standardnotes with a self-hosted Standard Notes server

You can point this MCP server at any Standard Notes server you control — your own [`standardnotes/server`](https://github.com/standardnotes/server) instance, a homelab deployment, or a company-internal mirror.

## Bring up a Standard Notes server with docker-compose

The fastest way is the upstream recipe.

```bash
git clone https://github.com/standardnotes/server.git
cd server
cp .env.sample .env
# Edit .env: pick strong values for SECRET_KEY_BASE, JWT_SECRET, AUTH_JWT_SECRET, etc.
docker compose up -d
```

By default the API is exposed on `http://localhost:3000`. For production you want it behind TLS — typically Caddy or nginx with Let's Encrypt sitting in front of the docker network.

See the [official self-hosting docs](https://standardnotes.com/help/47/can-i-self-host-standard-notes) for the full walkthrough, including the Files server (optional) and a web client.

## Point this MCP at it

### 1. Create your account

Use the official Standard Notes app (web or desktop) and register against your server URL. Make sure you end up on protocol 004 — it's the default for new accounts since 2020.

### 2. Configure mcp-standardnotes

Pass `SN_SERVER_URL` when running the login and the server:

```bash
SN_SERVER_URL=https://sn.example.com SN_EMAIL=you@example.com npm run login
```

Then in your Claude config:

```json
{
  "mcpServers": {
    "mcp-standardnotes": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-standardnotes/dist/index.js"],
      "env": {
        "SN_EMAIL": "you@example.com",
        "SN_SERVER_URL": "https://sn.example.com"
      }
    }
  }
}
```

### 3. Pin the TLS certificate (recommended)

For self-hosted servers — especially homelab setups with self-signed or short-lived certs — set `SN_CERT_FINGERPRINT` to the SHA-256 fingerprint of the server's leaf certificate. The MCP will refuse to talk to any other certificate, even if a CA in your trust store would otherwise vouch for it.

Get the fingerprint from your server:

```bash
echo | openssl s_client -connect sn.example.com:443 -servername sn.example.com 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 \
  | sed 's/^.*=//; s/://g; y/ABCDEF/abcdef/'
```

Output looks like `7a3c9b...` (64 hex chars). Set it in your env:

```bash
SN_CERT_FINGERPRINT=7a3c9b... SN_SERVER_URL=https://sn.example.com npm run login
```

And mirror it into your Claude config's `env` block. Re-run the fingerprint extraction after every cert renewal.

## Account / users-per-server

Each MCP instance is single-account. If you host multiple users on the same SN server, run one `mcp-standardnotes` per user (one Claude config entry each, distinct `KEYCHAIN_SERVICE` values to avoid keychain collisions).

```json
{
  "mcpServers": {
    "alice-notes": {
      "command": "node",
      "args": ["/path/to/mcp-standardnotes/dist/index.js"],
      "env": {
        "SN_EMAIL": "alice@example.com",
        "SN_SERVER_URL": "https://sn.example.com",
        "KEYCHAIN_SERVICE": "mcp-sn-alice"
      }
    },
    "bob-notes": {
      "command": "node",
      "args": ["/path/to/mcp-standardnotes/dist/index.js"],
      "env": {
        "SN_EMAIL": "bob@example.com",
        "SN_SERVER_URL": "https://sn.example.com",
        "KEYCHAIN_SERVICE": "mcp-sn-bob"
      }
    }
  }
}
```

## Operational notes

- **Backups.** This MCP keeps no state of its own beyond the keychain entry — backups are 100% your SN server's job. Use the upstream backup recipe.
- **Rate limiting.** Self-hosted servers usually have looser limits than the cloud, but the MCP still respects 429 responses.
- **Files server.** Not yet supported — this MCP only handles notes and tags. File uploads/downloads remain in the official app.
- **CI against your server.** Don't. Run integration tests against an ephemeral docker-compose instance only.

## Troubleshooting

If you can log in via the official SN app but `npm run login` fails, the most common causes are:

- `SN_SERVER_URL` includes a trailing slash or wrong scheme — drop the slash, use `https://`.
- TLS cert is invalid (expired, wrong hostname, untrusted CA): fix it at the server, or pin with `SN_CERT_FINGERPRINT` if it's intentional self-signed.
- Account is on legacy protocol 003: upgrade via the SN app (Preferences → Security → Upgrade Encryption).
