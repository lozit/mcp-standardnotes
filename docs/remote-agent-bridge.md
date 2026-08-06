# Exposing mcp-standardnotes to a remote agent (Cloudflare Tunnel + Access)

This guide walks through the setup you need if you want to let an autonomous AI agent — running on a remote server rather than on your laptop — read and write your Standard Notes vault through `mcp-standardnotes`. Think "a Hermes on a VPS", a self-hosted LangGraph worker, a Claude Agent SDK deployment, or any other MCP client that isn't Claude Desktop or Claude Code running next to your keychain.

The `mcp-standardnotes` server is designed to be run **locally over stdio only**, on the same machine as your OS keychain. This is a deliberate constraint: as long as the server never opens a network port, there is no attack surface beyond the local user account. But if you want a remote agent to consume it, you have to bridge that stdio interface to HTTP, expose it publicly, and put strong authentication in front. This guide shows how to do that without weakening the local threat model any more than the setup fundamentally requires.

## Who this is for

Read this guide if all of the following are true:

- You've already got `mcp-standardnotes` working locally (logged in, session in the keychain, Claude Desktop or Claude Code talking to it happily).
- You have an always-on Mac or Linux workstation that can host a small daemon 24/7.
- You control a domain managed by Cloudflare (or are willing to move one).
- You have a VPS or container platform where your agent runs.
- You've read the "Threat model" section below and you're comfortable with what it says.

If any of those doesn't hold, the [Alternatives](#what-this-guide-does-not-cover) section at the end lists options that may fit better.

## Threat model

The point of this section is to make explicit what you're signing up for. It's short but load-bearing — please don't skip it.

The default `mcp-standardnotes` deployment stores your derived master key in your OS keychain and never opens a network port. An attacker would need local user access to your machine to decrypt anything. That's a strong posture.

The setup in this guide **preserves the master-key posture**: your master key stays in your local Mac's keychain, the local `mcp-standardnotes` process is the only thing that ever holds it in memory, and no bytes of your vault ever leave the machine in decrypted form except in the specific tool responses that the remote agent explicitly asked for.

What changes is that you're now exposing an authenticated HTTP endpoint that, if compromised, allows the attacker to call MCP tools as if they were the remote agent. Concretely:

- **What an attacker can do if they steal your Cloudflare service token** — read, search, list your notes; create notes; update or attach tags; anything a normal MCP call can do. The blast radius is "the tool set you've exposed to your agent", not "your whole vault decryption key". Rotating the service token in Cloudflare Zero Trust invalidates their access without touching your Standard Notes credentials.
- **What an attacker still cannot do** — decrypt your vault offline from your Cloudflare account, obtain your Standard Notes password, or persist access after you rotate the token. The master key never leaves your Mac.
- **What you must actively avoid** — putting `notes_delete` or `tags_delete` in your agent's tool allowlist. A malicious or hallucinating agent that can call `notes_delete` can wipe your vault before you notice, and Standard Notes trash retention is only 30 days by default. Use `tools.exclude` (or the equivalent in your agent) to keep destructive tools off the table.

Two ideas that sound better than they are:

- "I'll just skip Cloudflare Access and rely on the tunnel being secret." Anyone who guesses or scans the tunnel URL has full access to your vault. Do not do this.
- "I'll run `mcp-standardnotes-login` directly on the VPS instead of tunneling from my Mac." Now your master key is on someone else's hardware. The blast radius of a VPS compromise is much larger — offline decryption of your entire vault, plus theft of your Standard Notes credentials the next time the client refreshes them. Only do this if you truly own the hardware and you accept the trade-off; it's not the setup this guide describes.

## Prerequisites

- **A Mac or Linux workstation** you leave running when you want the agent to work. macOS is what the instructions target directly (LaunchAgent); Linux users can substitute a systemd user service with equivalent structure.
- **`mcp-standardnotes` installed and working locally** — the login has been done, the OS keychain has your session, and you've validated at least one round-trip with a local MCP client. If you haven't, do that first; see the main README.
- **[Homebrew](https://brew.sh)** on your Mac.
- **[uv](https://github.com/astral-sh/uv)** to install `mcp-proxy` (Python tool). If you already have `pipx` you can substitute it, but `uv` is what the examples use.
- **A domain managed by Cloudflare**. If you don't have one, either move a domain you own to Cloudflare's nameservers or buy a cheap one through Cloudflare Registrar. You need this for the tunnel + Access setup.
- **A VPS or container platform** where your agent runs. This guide's Hermes examples assume [Coolify](https://coolify.io/) on a small Hetzner instance, but any platform where you can set environment variables and edit a config file works.
- **An agent that speaks MCP as a client** and supports HTTP transport with custom headers. Hermes qualifies; so do the Claude Agent SDK, most LangGraph MCP integrations, and any framework that can consume the Streamable HTTP or SSE MCP transports.

## Architecture at a glance

```
Your Mac (always on)                                  Cloudflare edge                 Your VPS
+-----------------------------+                       +-----------------+              +---------------+
| mcp-standardnotes (stdio)   |                       |                 |              |               |
| + OS keychain (master key)  |                       |  Access checks  |   HTTPS +    |    Agent      |
+--------------|--------------+                       |  service token  |   headers    |   (MCP client)|
               |                                      |                 |<-------------|               |
+--------------v--------------+   local TCP  +-----+  |                 |              +---------------+
| mcp-proxy (SSE, 127.0.0.1)  |------------->|     |->|                 |
+-----------------------------+   :8080      |     |  +--------|--------+
                                             |     |           |
                                             |cloudf|           |  cloudflared long-lived tunnel
                                             |lared |           |  (outbound-only from your Mac)
                                             +-----+
```

Two daemons run on your Mac: `mcp-proxy` (Python tool that wraps the stdio server in an HTTP endpoint on `127.0.0.1:8080`) and `cloudflared` (Cloudflare's tunnel client). Cloudflare Access sits in front of the public URL and rejects any request that doesn't carry a valid service token. Your agent's config just needs the URL plus two header values.

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

## Step 2 — Cloudflare Tunnel + Access

Everything in this section is done in the Cloudflare Zero Trust dashboard (`one.dash.cloudflare.com`). If Zero Trust isn't yet activated on your account, the first page you land on will walk you through the two clicks (pick a team name, choose the Free plan — 50 users, no credit card).

### 2.1 Create the tunnel

**Networks → Tunnels → Create a tunnel**

- Connector type: `Cloudflared`
- Tunnel name: something meaningful like `mac-mcp-bridge`
- **Save tunnel**

Cloudflare shows an "Install connector" screen with a command like `sudo cloudflared service install eyJhIjoi…`. Run that exact command on your Mac. It installs `cloudflared` as a LaunchDaemon under `/Library/LaunchDaemons/`, which auto-starts at boot and auto-restarts on crash. Nothing to add on top.

Within a few seconds the CF dashboard shows the connector as **Running** (green).

### 2.2 Route the tunnel to a public hostname

Still on the tunnel's page, under **Route tunnel → Public Hostname → Add a public hostname**:

- Subdomain: pick one, e.g. `mcp-bridge` or `sn`
- Domain: your Cloudflare-managed zone
- Type: `HTTP` (not HTTPS — see note below)
- URL: `localhost:8080`
- **Save hostname**

Why HTTP and not HTTPS here: the "URL" field is the target *inside your Mac*. Traffic between Cloudflare's edge and the outside world is HTTPS with a Cloudflare-issued certificate (that's automatic). Traffic between `cloudflared` and `mcp-proxy` never leaves your Mac's loopback interface. Setting HTTPS there would require you to generate a self-signed cert for mcp-proxy, configure it, and tell cloudflared to trust it — all for zero security gain since the traffic doesn't cross a network.

Cloudflare adds the DNS record automatically. Give it 30 seconds to propagate, then:

```bash
curl -sSI https://<your-subdomain>.<your-domain>/ | head -3
```

At this point you should get a `HTTP/2 200` — but the endpoint is **completely unauthenticated**. Anyone who guesses this URL can call your MCP. Do the Access setup below immediately.

### 2.3 Create the Application Access

**Access → Applications → Create new application → Self-hosted and private → Public DNS → Continue with Self-hosted and private**

There are several sub-types under "Self-hosted and private". **Public DNS** is the right one — the others are for WARP-only or Workers-based setups.

On the application configuration page:

- **Application name**: something you'll recognize later, e.g. `SN MCP Bridge`
- **Session Duration**: 24 hours is fine
- **Application domain**: your subdomain + domain, e.g. `mcp-bridge` + `your-domain.com`
- Leave the rest at defaults; ignore the RDP/SSH/VNC section (irrelevant here)

Scroll to **Access policies → Add a policy**:

- **Policy name**: `Service token access`
- **Action**: **`Service Auth`** — **not** `Allow`. This is a Cloudflare-specific subtlety and it will bite you if you miss it. `Allow` requires a service token AND an identity-provider login (Google/GitHub/etc), which a headless service cannot do. `Service Auth` accepts a service token alone, which is what you want.
- **Configure rules → Include**:
  - Selector: `Service Auth`
  - Value: `Any Access Service Token` (you'll narrow this later if you want a specific-token restriction)

**Save policy → complete the wizard**. Verify the application appears in the Applications list.

### 2.4 Generate a service token

**Access → Service credentials → Create Service Token**

- Service Token Name: e.g. `agent-vps`
- Service Token Duration: pick the longest available (typically `Non-expiring` on paid tiers, `1 year` on Free)
- **Generate token**

**Copy both values immediately, then close the dialog.** The secret is shown once and cannot be recovered — Cloudflare only stores its hash. If you close it and don't have the secret, revoke and regenerate.

You now have:

- `CF_ACCESS_CLIENT_ID` — looks like `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.access`
- `CF_ACCESS_CLIENT_SECRET` — a long random string

### 2.5 Sanity check — Access is actually enforcing

From anywhere with `curl`:

```bash
# Without credentials — expect HTTP 403
curl -sSI https://<your-subdomain>.<your-domain>/sse | head -3

# With credentials — expect HTTP 200 + text/event-stream
curl -sSI \
  -H "CF-Access-Client-Id: <your-CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <your-CLIENT_SECRET>" \
  https://<your-subdomain>.<your-domain>/sse | head -3
```

If the first curl returns 200, **stop**. Access isn't in front of your tunnel and your endpoint is public. Go back to 2.3 and verify the application was actually saved (checking the Applications list is the definitive test — a "Save policy" click on the wrong step can leave you with a saved *policy* but no *application*).

If both curls behave as expected, the plumbing is complete. All that's left is the agent config.

---

## Step 3 — Agent configuration

### 3.1 Generic pattern

Whatever agent framework you use, it needs to know three things:

1. The MCP server URL — `https://<your-subdomain>.<your-domain>/sse`
2. Two HTTP headers on every request:
   - `CF-Access-Client-Id: <your-CLIENT_ID>`
   - `CF-Access-Client-Secret: <your-CLIENT_SECRET>`
3. Which MCP transport to use — **SSE** (not Streamable HTTP), because that's what mcp-proxy exposes in this mode

You should not put the client ID or secret directly in a config file that ends up in version control. Read them from environment variables and reference them from config. Every serious framework supports this.

You should also configure the tool allowlist to **exclude at minimum** `notes_delete` and `tags_delete`, so a runaway agent can't wipe your vault autonomously. Standard Notes' trash retention will save you if you notice within 30 days, but "notice within 30 days" is not a defense strategy.

### 3.2 Hermes example

If your agent is [Hermes Agent](https://github.com/nousresearch/hermes-agent), the config looks like this. Place it in whichever profile you want to grant vault access to — a profile scoped to a specific chat is safer than the default profile.

```yaml
mcp_servers:
  standardnotes:
    url: "https://<your-subdomain>.<your-domain>/sse"
    transport: sse    # explicit — Hermes' auto-detect broke in v0.20.0, see troubleshooting
    headers:
      CF-Access-Client-Id: "${CF_ACCESS_CLIENT_ID}"
      CF-Access-Client-Secret: "${CF_ACCESS_CLIENT_SECRET}"
    enabled: true
    timeout: 120
    tools:
      exclude:
        - notes_delete
        - tags_delete
```

Set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` as environment variables on the container/process. On Coolify specifically, make sure **both** "Available at Buildtime" and "Available at Runtime" are checked — a runtime-only environment variable ends up invisible to build-time processes, and vice versa; the safest default is to check both.

Restart Hermes. Verify the MCP shows up:

```
hermes tools
```

You should see 16 tools under `MCP Server: standardnotes`, with `notes_delete` and `tags_delete` displayed as disabled (unchecked). If the MCP doesn't appear at all, jump to troubleshooting — the most common cause is the transport line.

### 3.3 Other agent frameworks

Every framework has its own config shape but the essentials are the same. A few pointers:

- **Claude Agent SDK / official MCP clients**: pass the two headers via the `headers` field of the SSE transport constructor. See the [MCP TypeScript SDK docs](https://github.com/modelcontextprotocol/typescript-sdk) for the exact syntax.
- **LangGraph MCP integrations**: most wrappers accept custom headers in their config. Grep the wrapper's source for `Authorization` or `headers`.
- **Anything else**: if the framework can hit an SSE endpoint with arbitrary headers, it can consume this bridge. If it can only speak Streamable HTTP, you'll need a different local wrapper (mcp-proxy doesn't expose Streamable HTTP in its current "SSE-to-stdio" mode; a small custom Node/Python bridge using the MCP SDK's `StreamableHTTPServerTransport` is the workaround).

---

## End-to-end verification

Two checks:

**From your VPS (host, not inside the agent's container)** — proves the network path works from where the agent will call:

```bash
curl -sSI \
  -H "CF-Access-Client-Id: <your-CLIENT_ID>" \
  -H "CF-Access-Client-Secret: <your-CLIENT_SECRET>" \
  https://<your-subdomain>.<your-domain>/sse | head -3
```

Expect `HTTP/2 200 text/event-stream`.

**From the agent itself** — ask the agent (via whatever interface you normally use) to run a low-risk MCP call, e.g.:

> List the 3 most recently updated notes with their titles only.

You should get the three titles. If it says the MCP isn't available, or times out, jump to troubleshooting.

If you want to test the full write path, ask the agent to create a distinctively-named note (e.g. `bridge-test-<timestamp>`), then check that it shows up in the Standard Notes mobile or desktop app within a few seconds. Delete the test note manually from the app afterwards (your allowlist forbids the agent from doing so, on purpose).

---

## Troubleshooting

The following are all things we hit while building this setup. Save yourself the debugging time.

### Cloudflare Access returns 403 even with correct headers

Two likely causes:

1. **The `Action` on your Access policy is `Allow` instead of `Service Auth`.** `Allow` requires the caller to also authenticate via an identity provider, which a headless service can't do. Fix in the Access policy: change Action to `Service Auth`.

2. **Header value corruption in your shell.** If you paste a long secret as a positional shell arg with quoting, a line break in the middle of the value silently truncates it. Prefer either an env var (`CF_SECRET=… curl -H "CF-Access-Client-Secret: $CF_SECRET" …`) or read the value from a file. The bug is invisible: you'll see the header sent, but with a truncated value.

### Cloudflare Access returns 200 even *without* headers

Access isn't in front of your tunnel. Almost always because the Access application was never actually saved — the "Save policy" button saves the policy inside the builder but doesn't finalize the application. Go to **Access → Applications** and verify the application is listed. If it isn't, redo the create flow and make sure the wizard reaches an "application created" confirmation.

### Agent reports `CancelledError` on MCP connect (Hermes v0.20.0+)

The agent tries the Streamable HTTP transport first, fails silently (mcp-proxy's SSE endpoint returns 405 to a POST), then some frameworks don't fall back cleanly and abort with `CancelledError`. Fix by declaring the transport explicitly in your MCP client config. For Hermes:

```yaml
mcp_servers:
  standardnotes:
    transport: sse    # add this line
    ...
```

For frameworks based on the MCP TypeScript SDK, instantiate `SSEClientTransport` directly instead of relying on transport auto-detection.

### `mcp-proxy --help` throws `ImportError` on `request_ctx`

Covered in section 1.2. The `mcp-proxy 0.12.0` release predates the MCP Python SDK's `2.0` release; the SDK removed a symbol mcp-proxy still imports. Pin the SDK back:

```bash
uv pip install --python ~/.local/share/uv/tools/mcp-proxy/bin/python 'mcp<2.0.0'
```

### `curl -I` on `/sse` alternates between 200 and timeout

Symptom: repeated `curl -I https://.../sse` returns 200, timeout, 200, timeout, in a strict 1-of-2 pattern. **This is a red herring** — it only happens with HEAD requests on an SSE endpoint, which is not how real MCP clients speak. mcp-proxy holds the connection open on HEAD waiting for a body it never sends, blocking the slot for the next request until the timeout frees it. Test with a proper GET instead:

```bash
timeout 3 curl -sSN --max-time 3 https://.../sse
```

which returns `event: endpoint / data: /messages/?session_id=…` consistently. Every real MCP client uses GET, so this bug never affects real usage.

### Hermes container fails to start with `entrypoint-dispatch.sh: no such file`

Specific to upgrading Hermes across a major version while a persistent volume holds the old container's `/opt/hermes` layout. The old volume shadows the new image's files, so the new entrypoint isn't found. Fix:

```bash
docker rm hermes-agent-<coolify-suffix>
docker rm hermes-webui-<coolify-suffix>
docker volume rm <coolify-suffix>_hermes-agent-src
# Then redeploy — the fresh volume will be repopulated by the new image at boot
```

Do **not** delete the `_hermes-home` volume — it holds your user config, credentials, and conversation history. Only the `_hermes-agent-src` volume is safe to wipe (it's the image's own source tree, re-created on each container start).

### Hermes-WebUI fails to build with `Building wheels or sdists for hermes-agent is not supported`

Specific to Hermes-WebUI when it tries to `pip install` the backend as a Python dependency. Hermes-agent v0.20+ explicitly blocks wheel installation with a `RuntimeError` unless a special build flag is set. Add the env var:

```
HERMES_NIX_BUILD=1
```

on the WebUI container, with **both** "Buildtime" and "Runtime" checked on Coolify. This bypasses the block.

### Environment variables added on Coolify aren't visible to the process

Coolify separates env vars into "Buildtime" and "Runtime" scopes. A common trap: you add `CF_ACCESS_CLIENT_ID` marked only Buildtime, and the running container sees nothing. Solution: check **both** boxes when adding the variable, unless you know for certain that only one applies.

Sanity-check inside the running container:

```bash
docker exec <container> env | grep CF_ACCESS
```

If the variable is empty or missing, edit it in Coolify, ensure Runtime is checked, and **redeploy** (not just restart — env var propagation to a container happens at deploy time).

### The agent sees stale data or overwrites recent changes made from another client

Cache staleness. Fixed in mcp-standardnotes `v0.6.0` — upgrade to that version or newer. Reads now refresh from the server after `SN_CACHE_TTL_MS` milliseconds (default 30 seconds); writes force a refresh unconditionally so they can never overwrite a fresher server-side revision.

---

## What this guide does not cover

- **Mobile agents.** If you want your agent to talk to your vault from your phone, this setup isn't it — mobile Claude runs in Anthropic's cloud, not on the device, so exposing a local endpoint to a mobile app requires a completely different architecture. The most viable path today is the [official Standard Notes mobile app](https://standardnotes.com) for direct vault access, combined with a desktop agent for automation.
- **Redundancy of the local Mac.** If your Mac goes down (power outage, hardware failure, someone unplugs it), the agent loses vault access until the Mac is back up. Solutions range from "just accept it" (fine for most personal setups) to "run the wrapper on a self-hosted Linux mini-PC that's more resilient than your daily driver". The instructions in this guide translate almost 1:1 to a Linux host — swap `LaunchAgent` for a systemd user service and Homebrew paths for your distro's paths.
- **Automatic rotation of the Cloudflare service token.** Manual rotation via the Cloudflare Access dashboard is straightforward (revoke, create new, update env vars on the VPS, redeploy the agent). Automating it via the Cloudflare API is possible but out of scope here.
- **Alternatives to Cloudflare Tunnel.** [Tailscale Funnel](https://tailscale.com/kb/1223/funnel/) offers a similar pattern with authentication via tailnet identity instead of a service token; slightly more elegant for personal use but requires everyone involved to be in the tailnet. NGINX or Caddy on a bastion host with client-cert authentication is another option, more effort to set up but under your full control.

If you find gaps or hit a problem this guide doesn't help with, open an issue on [github.com/lozit/mcp-standardnotes](https://github.com/lozit/mcp-standardnotes/issues).
