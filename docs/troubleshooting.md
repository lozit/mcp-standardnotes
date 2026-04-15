# Troubleshooting

### "No session found. Run `npm run login` to authenticate first."

The keychain lookup (`service: mcp-standardnotes`, `account: SN_EMAIL`) found nothing. Make sure `SN_EMAIL` matches the email you used at login **exactly** (case-sensitive on some OSes).

### "Account is not on protocol 004..."

Legacy 003 accounts are rejected. Upgrade via the official Standard Notes app (Preferences → Security → Upgrade Encryption).

### Notes created via MCP don't appear in the official SN app

This was a known bug fixed in early 2026: the AAD `kp` field must be omitted for items-key-encrypted notes/tags (it's only included for items_keys encrypted under the root key). If you're on an old revision of this project and see this symptom, update.

### Server disconnects immediately in Claude Desktop

Logs show `SyntaxError: Unexpected token '??='`?

Claude Desktop does not inherit your shell's `nvm` setup — it's resolving `node` to an old version from its own PATH. Use an **absolute path** to a Node ≥ 20 binary in the `command` field:

```json
{
  "mcpServers": {
    "mcp-standardnotes": {
      "command": "/Users/you/.nvm/versions/node/v22.13.1/bin/node",
      "args": ["/absolute/path/to/mcp-standardnotes/dist/index.js"],
      "env": { "SN_EMAIL": "you@example.com" }
    }
  }
}
```

Then quit Claude Desktop completely (Cmd-Q) and relaunch.

Logs are at `~/Library/Logs/Claude/mcp-server-mcp-standardnotes.log`.

### Rate limited (429) after repeated logins

Standard Notes caps auth at ~5/min. Wait a minute before retrying. Do **not** retry in a loop.

### Sync returns conflicts

On create/update, if the server returns conflicts, the MCP throws with the conflict payload instead of silently swallowing. For `notes_update`, the common cause is a stale `updated_at_timestamp` — fetch the note fresh (`notes_get`) and retry.

### keytar fails to install on Linux

`keytar` needs `libsecret` at build time. On Debian/Ubuntu:

```bash
sudo apt-get install libsecret-1-dev
```

On Fedora/RHEL:

```bash
sudo dnf install libsecret-devel
```

### I want to switch accounts

Wipe the current session from the keychain, then re-login:

```bash
SN_EMAIL=old@example.com npm run logout
SN_EMAIL=new@example.com npm run login
```
