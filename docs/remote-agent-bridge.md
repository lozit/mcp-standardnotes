# Exposing mcp-standardnotes to a remote agent (Cloudflare MCP Portals)

This guide walks through the setup you need if you want to let an autonomous AI agent — running on a remote server rather than on your laptop — read and write your Standard Notes vault through `mcp-standardnotes`. Think "a Hermes on a VPS", a self-hosted LangGraph worker, a Claude Agent SDK deployment, or any other MCP client that isn't Claude Desktop or Claude Code running next to your keychain.

The `mcp-standardnotes` server is designed to be run **locally over stdio only**, on the same machine as your OS keychain. This is a deliberate constraint: as long as the server never opens a network port, there is no attack surface beyond the local user account. To let a remote agent consume it, you bridge that stdio interface to HTTP, expose it publicly through a Cloudflare tunnel, and put a Cloudflare MCP Portal in front of it. This guide shows how to do that without weakening the local threat model any more than the setup fundamentally requires.

> **Note on Cloudflare MCP Portals.** At the time of writing, Cloudflare MCP Portals is in public Beta inside the Zero Trust dashboard. It replaces the older "manual Cloudflare Access Application" pattern that this guide used to describe (that pattern is still in the git history of this file if you need it — but it's roughly ten times more clicks, has more traps, and misses features Portals brings for free like automatic tool discovery). If Portals is unavailable in your region or plan, fall back to Cloudflare Access Applications directly — same building blocks, more manual assembly.

## Who this is for

Read this guide if all of the following are true:

- You've already got `mcp-standardnotes` working locally (logged in, session in the keychain, Claude Desktop or Claude Code talking to it happily).
- You have an always-on Mac or Linux workstation that can host a small daemon 24/7.
- You control a domain managed by Cloudflare (or are willing to move one).
- You have a VPS or container platform where your agent runs.
- Cloudflare Zero Trust Free is activated on your account (2 minutes to activate if not — the onboarding is a single team-name pick).
- You've read the "Threat model" section below and you're comfortable with what it says.

If any of those doesn't hold, the [Alternatives](#what-this-guide-does-not-cover) section at the end lists options that may fit better.

## Threat model

The point of this section is to make explicit what you're signing up for. It's short but load-bearing — please don't skip it.

The default `mcp-standardnotes` deployment stores your derived master key in your OS keychain and never opens a network port. An attacker would need local user access to your machine to decrypt anything. That's a strong posture.

The setup in this guide **preserves the master-key posture**: your master key stays in your local Mac's keychain, the local `mcp-standardnotes` process is the only thing that ever holds it in memory, and no bytes of your vault ever leave the machine in decrypted form except in the specific tool responses that the remote agent explicitly asked for.

What changes is that you're now exposing an authenticated HTTP endpoint that, if compromised, allows the attacker to call MCP tools as if they were the remote agent. Concretely:

- **What an attacker can do if they steal your Cloudflare service token** — read, search, list your notes; create notes; update or attach tags; anything a normal MCP call can do. The blast radius is "the tool set you've exposed to your agent", not "your whole vault decryption key". Rotating the service token in Cloudflare Zero Trust invalidates their access without touching your Standard Notes credentials.
- **What an attacker still cannot do** — decrypt your vault offline from your Cloudflare account, obtain your Standard Notes password, or persist access after you rotate the token. The master key never leaves your Mac.
- **What you must actively avoid** — putting `notes_delete` or `tags_delete` in your agent's tool allowlist. A malicious or hallucinating agent that can call `notes_delete` can wipe your vault before you notice, and Standard Notes trash retention is only 30 days by default. Use Cloudflare Portals' "Tools authorized" toggles (or your agent's `tools.exclude`, or both) to keep destructive tools off the table.

Two ideas that sound better than they are:

- "I'll just skip the Portal auth and rely on the tunnel URL being secret." Anyone who guesses or scans the tunnel URL has full access to your vault. Do not do this.
- "I'll run `mcp-standardnotes-login` directly on the VPS instead of tunneling from my Mac." Now your master key is on someone else's hardware. The blast radius of a VPS compromise is much larger — offline decryption of your entire vault, plus theft of your Standard Notes credentials the next time the client refreshes them. Only do this if you truly own the hardware and you accept the trade-off; it's not the setup this guide describes.

## Prerequisites

- **A Mac or Linux workstation** you leave running when you want the agent to work. macOS is what the instructions target directly (LaunchAgent); Linux users can substitute a systemd user service with equivalent structure.
- **`mcp-standardnotes` installed and working locally** — the login has been done, the OS keychain has your session, and you've validated at least one round-trip with a local MCP client. If you haven't, do that first; see the main README.
- **[Homebrew](https://brew.sh)** on your Mac.
- **[uv](https://github.com/astral-sh/uv)** to install `mcp-proxy` (Python tool). If you already have `pipx` you can substitute it, but `uv` is what the examples use.
- **A domain managed by Cloudflare**. If you don't have one, either move a domain you own to Cloudflare's nameservers or buy a cheap one through Cloudflare Registrar.
- **Cloudflare Zero Trust activated**. The Zero Trust dashboard is at `one.dash.cloudflare.com`; the Free plan (50 users, no credit card) is more than enough for this use case.
- **A VPS or container platform** where your agent runs. This guide's examples reference [Coolify](https://coolify.io/) on a small Hetzner instance for the Hermes side, but any platform where you can set environment variables and edit a config file works.
- **An agent that speaks MCP as a client** and supports HTTP transport (Streamable HTTP specifically, since that's what Portals expose) with custom headers. Hermes qualifies; so do the Claude Agent SDK, most LangGraph MCP integrations, and any framework built on the MCP TypeScript/Python SDK.

## Architecture at a glance

```
Your Mac (always on)                   Cloudflare edge                                          Your VPS
+---------------------------------+                                                          +------------+
| mcp-standardnotes (stdio)       |                                                          |            |
| + OS keychain (master key)      |    +---------+   +-------------------+                   |   Agent    |
+----------------|----------------+    |         |   |                   |     HTTPS         |            |
                 |                     | Tunnel  |-->| MCP Server Portal |-->  streamable-<--|            |
+----------------v----------------+    | (edge)  |   |   (paranoid-mcp)  |     http + CF     +------------+
| mcp-proxy (SSE, 127.0.0.1:8080) |----|         |   |                   |    -Access hdrs
+---------------------------------+    +----|----+   +---------|---------+
                                            |                  |
                                            |                  +-- Access Application (auto-created)
                                            |                       Policy: Service Auth token
                                            |
                                       cloudflared tunnel
                                       (outbound-only from Mac)
```

Two daemons run on your Mac: `mcp-proxy` (Python tool that wraps stdio in an SSE endpoint on `127.0.0.1:8080`) and `cloudflared` (Cloudflare's tunnel client). Cloudflare declares your MCP server, wraps it in a Portal, and generates the Access Application + policy automatically. Your agent's config just needs the portal URL plus two header values.

Nothing on your Mac ever accepts inbound network connections from the public internet — `mcp-proxy` binds to localhost only, and `cloudflared` establishes outbound tunnels to Cloudflare's edge.

---

## Step 1 — Local HTTP wrapper on your Mac

### 1.1 Install the two binaries

```bash
brew install cloudflared
uv tool install mcp-proxy
```

Verify:

```bash
which cloudflared    # should print /opt/homebrew/bin/cloudflared
which mcp-proxy      # should print ~/.local/bin/mcp-proxy
```

### 1.2 Pin `mcp-proxy`'s MCP SDK dependency

At the time of writing, `mcp-proxy 0.12.0` (the latest stable) is incompatible with `mcp` SDK version `2.x` — the SDK removed a symbol that mcp-proxy still imports. Symptom: running `mcp-proxy --help` throws `ImportError: cannot import name 'request_ctx' from 'mcp.server.lowlevel.server'`.

Fix (safe and reversible):

```bash
uv pip install --python ~/.local/share/uv/tools/mcp-proxy/bin/python 'mcp<2.0.0'
```

Verify `mcp-proxy --help` runs without traceback before continuing.

### 1.3 First manual test

Run mcp-proxy in the foreground once, to make sure it wraps the stdio server correctly:

```bash
mcp-proxy --port 8080 --host 127.0.0.1 \
  -e SN_EMAIL you@example.com \
  $(which mcp-standardnotes)
```

Two things to note:

- `-e SN_EMAIL you@example.com` — `mcp-proxy` does **not** forward the parent process's environment to the subprocess by default, so you have to hand it `SN_EMAIL` explicitly. The alternative is `--pass-environment`, which forwards everything and is more than you want.
- Use `$(which mcp-standardnotes)` to give the subprocess an absolute path. LaunchAgent (next section) doesn't inherit a shell PATH.

Watch the output. When you see `Uvicorn running on http://127.0.0.1:8080`, in another terminal:

```bash
curl -sSN --max-time 3 http://127.0.0.1:8080/sse -w '\n[HTTP %{http_code}]\n'
```

You should see an `event: endpoint` line with a `session_id`. That means mcp-proxy successfully spoke to your local mcp-standardnotes and set up an SSE session. Kill the foreground `mcp-proxy` with Ctrl-C.

### 1.4 Make it survive reboots (LaunchAgent)

Create `~/Library/LaunchAgents/com.mcpstandardnotes.proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.mcpstandardnotes.proxy</string>

    <!-- LaunchAgent processes don't inherit your shell PATH, so `env node`
         in the mcp-standardnotes shebang cannot resolve `node`. Set PATH
         explicitly to include your Node install location. Adjust the nvm
         path below to your own Node version. -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/you/.nvm/versions/node/vXX.Y.Z/bin:/usr/bin:/bin</string>
    </dict>

    <key>ProgramArguments</key>
    <array>
        <string>/Users/you/.local/bin/mcp-proxy</string>
        <string>--port</string>
        <string>8080</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>-e</string>
        <string>SN_EMAIL</string>
        <string>you@example.com</string>
        <string>/Users/you/.nvm/versions/node/vXX.Y.Z/bin/mcp-standardnotes</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <!-- Auto-restart on crash, but NOT after a clean shutdown (e.g. explicit
         `launchctl unload`). Prevents launchd resurrecting a process the
         user just asked to stop. -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>/Users/you/Library/Logs/mcp-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/Library/Logs/mcp-proxy.log</string>
</dict>
</plist>
```

Replace every `you`, `you@example.com`, and `vXX.Y.Z` with your own values. Then load it:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.mcpstandardnotes.proxy.plist
launchctl print gui/$UID/com.mcpstandardnotes.proxy | grep -E 'state|last exit'
```

You should see `state = running` and `last exit code = (never exited)`. If not, check `~/Library/Logs/mcp-proxy.log` — the most common cause is a wrong Node path in `EnvironmentVariables.PATH` or `ProgramArguments`.

To stop it later:

```bash
launchctl bootout gui/$UID/com.mcpstandardnotes.proxy
```

---

## Step 2 — Cloudflare Tunnel

Everything in this section is done in the Zero Trust dashboard (`one.dash.cloudflare.com`).

### 2.1 Create the tunnel

**Networks → Tunnels → Create a tunnel**

- Connector type: `Cloudflared`
- Tunnel name: something meaningful like `mac-mcp-bridge`
- **Save tunnel**

Cloudflare shows an "Install connector" screen with a command like `sudo cloudflared service install eyJhIjoi…`. Run that exact command on your Mac. It installs `cloudflared` as a LaunchDaemon under `/Library/LaunchDaemons/`, which auto-starts at boot and auto-restarts on crash. Nothing to add on top.

Within a few seconds the CF dashboard shows the connector as **Running** (green).

### 2.2 Route the tunnel to a public hostname

Still on the tunnel's page, under **Published application routes → Add a published application route** (older UI versions call this "Public Hostnames"):

- Subdomain: pick one, e.g. `sn` or `standardnotes-mcp`
- Domain: your Cloudflare-managed zone
- Type: `HTTP` (not HTTPS — see note below)
- URL: `localhost:8080`
- **Save**

Why HTTP and not HTTPS here: the "URL" field is the target *inside your Mac*. Traffic between Cloudflare's edge and the outside world is HTTPS with a Cloudflare-issued certificate (that's automatic). Traffic between `cloudflared` and `mcp-proxy` never leaves your Mac's loopback interface. Setting HTTPS there would require you to generate a self-signed cert for mcp-proxy, configure it, and tell cloudflared to trust it — all for zero security gain since the traffic doesn't cross a network.

Cloudflare adds the DNS record automatically. Give it 30 seconds to propagate, then verify:

```bash
curl -sSI https://<your-subdomain>.<your-domain>/ | head -3
```

At this point you should get `HTTP/2 200` — the endpoint is **completely unauthenticated**. Anyone who guesses this URL can call your MCP. Do the Portal setup below immediately.

---

## Step 3 — Cloudflare MCP Portals

This is where Portals replaces the older "manual Cloudflare Access Application" pattern. Zero Trust → **Access controls → MCP Portals**. Two tabs at the top: **Server portals** and **MCP servers**. Add the individual MCP server first, then wrap it in a portal.

### 3.1 Declare mcp-standardnotes as an MCP server

**MCP servers → + Add MCP server**

- **Server name**: `mcp-standardnotes`
- **Server ID**: `mcp-standardnotes` (32 chars max, kebab-case)
- **Description**: `Standard Notes vault via mcp-standardnotes`
- **HTTP URL**: `https://<your-subdomain>.<your-domain>/sse` (the tunnel hostname you just created)
- **Route traffic through Cloudflare Gateway**: leave **Off** (advanced inspection, out of scope here)
- **Authentication type**: **None**
  > Your origin is the tunnel above, which has no auth in front of it yet. That's fine — the auth we care about is enforced *in front* of the Portal, one layer up. If you had left an existing Access Application on the tunnel hostname (from an older setup), you would select `Custom headers` instead and pass `CF-Access-Client-Id` / `CF-Access-Client-Secret` so Portals can traverse it. This is documented in the Troubleshooting section.
- **Access policies** (block at the bottom):
  - **Create new policy**
  - **Policy name**: `Service token access`
  - **Action**: **`Service Auth`** (not `Allow` — see Troubleshooting)
  - **Configure rules → Include**: Selector `Service Auth`, Value `Any Access Service Token`
  - **Save policy**

Then **Save and connect server** in bottom-right.

Cloudflare probes the endpoint, does MCP tool discovery, and lists your server as **Ready** with the tool count filled in (e.g. `16 tools` for mcp-standardnotes as of v0.6.0). If the status is **Error** with an HTTP 403 sync error, jump to Troubleshooting.

### 3.2 Create the Server Portal

**Server portals → + Add server portal**

The portal is the single endpoint your agent will connect to. It holds N MCP servers and multiplexes them behind one URL.

- **Portal name**: something like `paranoid-mcp` or `personal-mcp` — the human-readable label
- **Portal ID**: 32-char slug, e.g. `personal-mcp`
- **Description**: e.g. `Personal MCPs — vault, notes, other tools`
- **Custom domain**:
  - **Subdomain**: e.g. `mcp`
  - **Domain**: your zone
  - → resulting URL: `https://mcp.<your-domain>` — this is what your agent will call
- **Route traffic through Cloudflare Gateway**: leave **Off**
- **Code mode**: leave **`Opt in`** (default) — Cloudflare Dynamic Workers-powered tool orchestration, safely off unless a client asks for it
- **Servers**: **Select existing servers** → check `mcp-standardnotes`
- **Access policies**: same pattern as 3.1 — `Create new policy` → `Service Auth` → `Any Access Service Token` → save
- **Add server portal**

The success banner confirms *"portal-id and associated MCP application successfully created"* — the Access Application that gates the portal is generated automatically. Under the older Application Access pattern, you had to create this application by hand in a separate wizard.

### 3.3 Generate a service token

**Access → Service credentials → Create Service Token**

- **Name**: e.g. `agent-vps`
- **Duration**: the longest allowed on your plan (typically `1 year` on Free, `Non-expiring` on paid)
- **Generate**

**⚠️ The secret is shown once.** Copy both values immediately into a secrets manager. You'll get:

- `CF_ACCESS_CLIENT_ID` — ends in `.access`
- `CF_ACCESS_CLIENT_SECRET` — long random string

### 3.4 Sanity check — Access is enforcing

From anywhere with `curl`:

```bash
# Without credentials — expect HTTP 401 with JSON body
curl -sSI https://mcp.<your-domain>/mcp | head -3

# With credentials — expect an MCP error response, NOT HTTP 401
curl -sSN --max-time 3 \
  -H "CF-Access-Client-Id: <your-CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <your-CLIENT_SECRET>" \
  https://mcp.<your-domain>/mcp -w '\n[HTTP %{http_code}]\n'
```

The second curl will return `{"jsonrpc":"2.0","error":...`Session expired or does not exist. Please reconnect."}` with HTTP 404. **That's not a failure** — it means auth succeeded and the portal reached the MCP layer, which correctly rejects a GET without a prior `initialize` POST (Streamable HTTP protocol expects an init handshake). Real MCP clients do that handshake automatically.

If the first curl returns 200, **stop** — the portal isn't in front of your tunnel and the endpoint is public. Verify in **Access → Applications** that a portal application exists and lists your portal's domain.

---

## Step 4 — Agent configuration

### 4.1 The three things any agent needs

1. **Portal URL** — `https://mcp.<your-domain>/mcp`
2. **Two HTTP headers on every request** — `CF-Access-Client-Id` and `CF-Access-Client-Secret`
3. **Streamable HTTP transport** (not SSE) — that's what MCP Portals speak. If your agent supports both, force Streamable HTTP explicitly.

You should not put the client ID or secret directly in a config file that ends up in version control. Read them from environment variables and reference them from config. Every serious framework supports this.

### 4.2 Tool naming inside a portal

Important detail: when tools go through a portal, Cloudflare **prefixes their names with the server ID**. What was `notes_list` on the raw MCP server becomes `mcp-standardnotes_notes_list` when reached via the portal. Any tool allow/deny list in your agent config **must use the prefixed names** — the raw names match nothing.

The portal itself also injects three meta-tools: `portal_list_servers`, `portal_toggle_servers`, `portal_toggle_single_server`. These let an agent dynamically enable/disable servers. Add them to your exclude list if you don't want your agent touching portal composition.

### 4.3 Hermes example config

Place this in the Hermes profile you want to grant vault access to (scoping to a specific chat is safer than the default profile):

```yaml
mcp_servers:
  personal-mcp:
    url: "https://mcp.<your-domain>/mcp"
    transport: streamable-http    # Portals speak Streamable HTTP, not SSE
    headers:
      CF-Access-Client-Id: "${CF_ACCESS_CLIENT_ID}"
      CF-Access-Client-Secret: "${CF_ACCESS_CLIENT_SECRET}"
    enabled: true
    timeout: 120
    tools:
      exclude:
        # Prefixed names because we go through a portal
        - mcp-standardnotes_notes_delete
        - mcp-standardnotes_tags_delete
        # Optionally also block the portal's own meta-tools
        - portal_toggle_servers
        - portal_toggle_single_server
        - portal_list_servers
```

Set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` as environment variables on the Hermes container/process. On Coolify specifically, check **both** "Available at Buildtime" and "Available at Runtime" boxes — a runtime-only variable ends up invisible at build time and vice versa.

Restart Hermes and verify:

```bash
hermes tools --profile <your-profile>
```

You should see an entry `MCP Server: personal-mcp` with your prefixed tools listed. The excluded ones should show as `[ ]` (unchecked).

### 4.4 Belt and suspenders — enforce exclusions server-side too

The `tools.exclude` above is a **client-side** filter. It stops Hermes from calling excluded tools, but any other client using the same portal (a second agent, a different profile) would see them. For defense in depth, disable the tools **at the portal level too**:

Zero Trust → **MCP Portals → Server portals → your portal → `mcp-standardnotes` row → "..." → Tools authorized** → uncheck `notes_delete` and `tags_delete`.

Now they're invisible to any client — not just filtered by one agent's config. This is the strongest guardrail available in this stack.

### 4.5 Other agent frameworks

- **Claude Agent SDK / official MCP clients**: instantiate `StreamableHTTPClientTransport` (not `SSEClientTransport`), pass the two headers via the transport's `headers` option. See the [MCP TypeScript SDK docs](https://github.com/modelcontextprotocol/typescript-sdk).
- **LangGraph MCP integrations**: most wrappers accept custom headers in their config. Grep the wrapper's source for `headers` or `Authorization` to find the right entry point.
- **Anything else**: if the framework can hit a Streamable HTTP endpoint with arbitrary headers, it can consume this portal. If it can only speak SSE, you'd need to swap to the older Access Application pattern (git history of this file has a version that describes it).

---

## Adding a second MCP to the same portal

Once you have one MCP wired, adding a second (say, `mcp-freestyle` or any other stdio MCP you run locally) is a small extension:

1. **On your Mac**: repeat Step 1 for the new MCP, but on a **different port** (e.g. `8081`) and with a **separate LaunchAgent plist** (e.g. `com.mcpfreestyle.proxy.plist`). Don't try to share a port.
2. **In your existing tunnel**: add a second published application route (Step 2.2) with a different subdomain, pointing to `localhost:8081`.
3. **In Cloudflare MCP Portals**: declare the second MCP server (Step 3.1). Then edit your existing portal (Step 3.2) → **Servers → Select existing servers** → check the new one → save. The portal now multiplexes both.
4. **In your agent**: no config change needed — same portal URL, same service token. New prefixed tools (`mcp-<new-server-id>_<tool>`) appear automatically at the next MCP tool listing.

Total additional effort: ~10 minutes per new MCP.

---

## Troubleshooting

The following are all things you're likely to hit. Save yourself the debugging time.

### Cloudflare Access returns 403 even with correct headers

Two likely causes:

1. **The `Action` on your Access policy is `Allow` instead of `Service Auth`.** `Allow` requires the caller to also authenticate via an identity provider, which a headless service can't do. Fix in the policy: change Action to `Service Auth`.

2. **Header value corruption in your shell.** If you paste a long secret as a positional shell arg with quoting, a line break in the middle of the value silently truncates it. Prefer either an env var (`CF_SECRET=… curl -H "CF-Access-Client-Secret: $CF_SECRET" …`) or read the value from a file. The bug is invisible: the header is sent, but with a truncated value.

### Cloudflare Access returns 200 even *without* headers

Access isn't in front of your tunnel. Almost always because either the Access application wasn't actually saved, or the MCP server / portal wasn't saved (a "Save policy" click inside the builder doesn't finalize the outer resource). Go to **Access → Applications** and verify the portal application is listed. If it isn't, redo the create flow and make sure the wizard reaches a confirmation banner.

### MCP server stuck in "Error" state with HTTP 403 in the sync log

The tunnel hostname you're pointing the MCP server at is **already protected by an older Access Application**. Cloudflare Portals tries to probe it during discovery and gets bounced by your own Access layer.

Two fixes:

1. **Preferred**: keep the old Access Application in place (it's defense in depth for the raw tunnel URL) and configure the MCP server's **Authentication type** as **`Custom headers`**. Add two headers: `CF-Access-Client-Id` and `CF-Access-Client-Secret`, with your service token values. Portals will present them when probing and traverse cleanly.
2. **Simpler but less safe**: delete the older Access Application. The raw tunnel URL becomes public; only the portal now stands between attackers and your MCP. Fine if you don't want to maintain two layers.

### Agent reports `CancelledError` or the MCP doesn't appear (Hermes v0.20+)

Some frameworks try the wrong transport first and fail silently. Declare the transport explicitly in your MCP client config. For Hermes:

```yaml
mcp_servers:
  personal-mcp:
    transport: streamable-http
    ...
```

For frameworks based on the MCP TypeScript SDK, instantiate `StreamableHTTPClientTransport` directly instead of relying on transport auto-detection.

### `mcp-proxy --help` throws `ImportError` on `request_ctx`

Covered in section 1.2. `mcp-proxy 0.12.0` predates the MCP Python SDK's `2.0` release; the SDK removed a symbol mcp-proxy still imports. Pin the SDK back:

```bash
uv pip install --python ~/.local/share/uv/tools/mcp-proxy/bin/python 'mcp<2.0.0'
```

### `curl -I` on `/sse` (the raw tunnel URL) alternates between 200 and timeout

Symptom: repeated `curl -I` returns 200, timeout, 200, timeout, in a strict 1-of-2 pattern. **This is a red herring** — it only happens with HEAD requests on an SSE endpoint, which is not how real MCP clients speak. mcp-proxy holds the connection open on HEAD waiting for a body it never sends, blocking the slot for the next request until the timeout frees it. Test with a proper GET instead:

```bash
curl -sSN --max-time 3 https://<your-subdomain>.<your-domain>/sse
```

which returns `event: endpoint / data: /messages/?session_id=…` consistently. Real MCP clients use GET, so this bug never affects real usage.

### `mcp-standardnotes` container fails to start with `entrypoint-dispatch.sh: no such file` after upgrading

Not this project's problem, but for reference: when upgrading Hermes (or any Docker MCP with a persistent source-code volume) across a major version, the persistent volume can shadow the new image's file layout. Fix: stop the containers, drop the source volume (not the data volume — check the compose to distinguish), redeploy.

### Environment variables added on Coolify aren't visible to the process

Coolify separates env vars into "Buildtime" and "Runtime" scopes. Check **both** boxes when adding a variable, then **redeploy** (not just restart — env vars propagate at deploy time).

Sanity-check inside the container:

```bash
docker exec <container> env | grep CF_ACCESS
```

### The agent sees stale data or overwrites recent changes made from another client

Cache staleness. Fixed in `mcp-standardnotes` `v0.6.0` — upgrade if you're not there yet. Reads now refresh from the server after `SN_CACHE_TTL_MS` milliseconds (default 30 seconds); writes force a refresh unconditionally.

---

## What this guide does not cover

- **Mobile agents.** If you want your agent to talk to your vault from your phone, this setup isn't it — mobile Claude runs in Anthropic's cloud, not on the device, so exposing a local endpoint to a mobile app requires a completely different architecture. The most viable path today is the [official Standard Notes mobile app](https://standardnotes.com) for direct vault access, combined with a desktop agent for automation.
- **Redundancy of the local Mac.** If your Mac goes down (power outage, hardware failure), the agent loses vault access until it's back up. Solutions range from "just accept it" (fine for most personal setups) to running the wrapper on a self-hosted Linux mini-PC. The instructions translate almost 1:1 to Linux — swap `LaunchAgent` for a systemd user service.
- **Automatic rotation of the Cloudflare service token.** Manual rotation via the dashboard is straightforward (revoke, create new, update env vars on the VPS, redeploy). Automating via the Cloudflare API is possible but out of scope here.
- **Alternatives to Cloudflare.** [Tailscale Funnel](https://tailscale.com/kb/1223/funnel/) offers a similar pattern with authentication via tailnet identity — slightly more elegant for personal use but requires everyone involved to be in the tailnet. NGINX or Caddy on a bastion host with client-cert authentication is another option, more effort but under your full control.
- **Automating the local machine setup.** The `mcp-proxy` + LaunchAgent + tunnel setup is the same for every MCP you add. A companion tool that reads a small YAML manifest and installs the local stack automatically (LaunchAgent generation, cloudflared route creation, service registration) would be a natural complement to Cloudflare Portals but doesn't exist yet as of writing. Contributions welcome.

If you find gaps or hit a problem this guide doesn't help with, open an issue on [github.com/lozit/mcp-standardnotes](https://github.com/lozit/mcp-standardnotes/issues).
