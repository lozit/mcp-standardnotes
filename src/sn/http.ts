import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Agent, fetch, type Dispatcher } from "undici";
import { logger } from "../security/logger.js";
import { redactString } from "../security/redact.js";
import type { KeyParams004 } from "./protocol004.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../../package.json") as {
  version: string;
};

// Cloudflare in front of api.standardnotes.com serves a JS challenge to
// requests whose headers don't look like a real browser. We can't solve the
// challenge in Node, so we avoid triggering it: send a Chrome UA, plus the
// Origin/Referer the SN web app would send. X-Client carries our real
// identity for SN's backend (CF doesn't gate on it).
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const X_CLIENT = `mcp-standardnotes/${PKG_VERSION}`;
const OFFICIAL_SN_HOST = "api.standardnotes.com";

// Standard Notes' api-gateway (since ~2026-05) rejects any request missing
// these two version headers with HTTP 400 "Your client version is no longer
// supported. Please update Standard Notes to the latest version." The gateway
// gates on these headers — NOT on the body `api` field. Bump them when the
// gateway raises its floor again (symptom: login suddenly 400s with that exact
// message). Current accepted values tracked upstream by github.com/jonhadfield/
// gosn-v2 (common/client_headers.go), which hit the same wall.
const SNJS_VERSION = "2.211.7";
const APP_VERSION = "Desktop-3.201.27";

function isOfficialSn(url: string): boolean {
  try {
    return new URL(url).hostname === OFFICIAL_SN_HOST;
  } catch {
    return false;
  }
}

export interface HttpConfig {
  serverUrl: string;
  authToken?: string;
}

let dispatcher: Dispatcher | undefined;
let dispatcherInitialized = false;

// Cloudflare in front of api.standardnotes.com flags HTTP/1.1 clients as bots
// regardless of headers — modern browsers/curl negotiate h2. Node's fetch
// defaults to h1.1, which fails the JS challenge. allowH2 makes undici
// negotiate ALPN h2 with the server, falling back to h1.1 if unsupported
// (so self-hosted servers without h2 still work).
function getDispatcher(): Dispatcher {
  if (dispatcherInitialized && dispatcher) return dispatcher;
  dispatcherInitialized = true;

  const expected = process.env.SN_CERT_FINGERPRINT;
  const agentOpts: ConstructorParameters<typeof Agent>[0] = { allowH2: true };

  if (expected) {
    const expectedNorm = expected.replace(/:/g, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedNorm)) {
      throw new Error(
        "SN_CERT_FINGERPRINT must be a SHA-256 fingerprint (64 hex chars, colons optional)",
      );
    }
    agentOpts.connect = {
      checkServerIdentity: (_host, cert) => {
        const got = (cert.fingerprint256 ?? "")
          .replace(/:/g, "")
          .toLowerCase();
        if (got !== expectedNorm) {
          return new Error(
            `TLS cert pinning mismatch: server presented fingerprint ` +
              `${got || "<missing>"} but SN_CERT_FINGERPRINT expects ${expectedNorm}`,
          );
        }
        return undefined;
      },
    };
    logger.info("TLS cert pinning enabled via SN_CERT_FINGERPRINT");
  }

  dispatcher = new Agent(agentOpts);
  return dispatcher;
}

export interface LoginParamsResponse {
  identifier: string;
  pw_nonce: string;
  version: "004";
  origination?: string;
  created?: string;
}

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
  access_expiration: number;
  refresh_expiration: number;
}

export interface LoginResponse {
  session: SessionTokens;
  key_params: KeyParams004;
  user: { uuid: string; email: string };
}

export interface RawItem {
  uuid: string;
  content_type: string;
  content: string;
  enc_item_key: string;
  items_key_id?: string | null;
  created_at: string;
  updated_at: string;
  created_at_timestamp: number;
  updated_at_timestamp: number;
  deleted: boolean;
}

export interface SyncResponse {
  retrieved_items: RawItem[];
  saved_items: RawItem[];
  conflicts: unknown[];
  sync_token: string;
  cursor_token?: string;
  integrity_hash?: string;
}

export interface MfaRequiredError extends Error {
  tag: "mfa-required";
  mfaKey: string;
}

export class SnApiError extends Error {
  readonly tag: string | undefined;
  readonly status: number;
  readonly payload: unknown;
  constructor(message: string, tag: string | undefined, status: number, payload: unknown) {
    super(message);
    this.tag = tag;
    this.status = status;
    this.payload = payload;
  }
}

interface SnError {
  tag?: string;
  message?: string;
  payload?: unknown;
}

interface SnEnvelope<T> {
  meta?: unknown;
  // Auth endpoints (/v2/login, /v2/login-params) return errors at the top
  // level; the sync/items endpoints nest them under `data`. Accept both.
  error?: SnError;
  data?: (T & { error?: SnError }) | undefined;
}

async function snFetch<T>(url: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", BROWSER_UA);
  if (!headers.has("X-Client")) headers.set("X-Client", X_CLIENT);
  // Required by the SN api-gateway (see SNJS_VERSION / APP_VERSION above).
  if (!headers.has("X-SNJS-Version")) {
    headers.set("X-SNJS-Version", SNJS_VERSION);
  }
  if (!headers.has("X-Application-Version")) {
    headers.set("X-Application-Version", APP_VERSION);
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json, text/plain, */*");
  }
  if (!headers.has("Accept-Language")) {
    headers.set("Accept-Language", "en-US,en;q=0.9");
  }
  if (isOfficialSn(url)) {
    if (!headers.has("Origin")) {
      headers.set("Origin", "https://app.standardnotes.com");
    }
    if (!headers.has("Referer")) {
      headers.set("Referer", "https://app.standardnotes.com/");
    }
  }
  const finalInit = {
    ...init,
    headers,
    dispatcher: getDispatcher(),
  };
  const res = await fetch(url, finalInit as Parameters<typeof fetch>[1]);
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const hint = retryAfter ? ` Retry after ${retryAfter}s.` : "";
    throw new SnApiError(
      `Rate limited by Standard Notes server (HTTP 429).${hint} ` +
        `Wait before retrying — do not loop.`,
      "rate-limited",
      429,
      retryAfter ? { retryAfter } : undefined,
    );
  }
  const text = await res.text();
  let body: SnEnvelope<T>;
  try {
    body = text ? (JSON.parse(text) as SnEnvelope<T>) : {};
  } catch {
    const snippet = redactString(text.slice(0, 200))
      .replace(/\s+/g, " ")
      .trim();
    throw new Error(
      `Non-JSON response from ${url} (status ${res.status})` +
        (snippet ? `: ${snippet}` : ""),
    );
  }
  const data = body.data as SnEnvelope<T>["data"];
  // SN puts the error at the top level on auth endpoints, under `data` on sync.
  const err = body.error ?? data?.error;
  if (!res.ok || err) {
    let message = err?.message ?? `HTTP ${res.status}`;
    // No structured message (unknown shape, or an error object without one):
    // attach a redacted snippet of the raw body so the failure is diagnosable
    // instead of an opaque "HTTP 400".
    if (!err?.message) {
      const snippet = redactString(text.slice(0, 200))
        .replace(/\s+/g, " ")
        .trim();
      if (snippet && snippet !== "{}") message += `: ${snippet}`;
    }
    throw new SnApiError(message, err?.tag, res.status, err?.payload);
  }
  return (data ?? ({} as T)) as T;
}

// ----- PKCE helpers (Standard Notes custom flavor — NOT RFC 7636) -----
//
// verifier  = hex(32 random bytes) — 64 lowercase hex chars
// challenge = base64url_nopad( utf8( hex(sha256( utf8(verifier) )) ) )
// The server stores the challenge during /v2/login-params, then recomputes
// from the submitted verifier on /v2/login.

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("hex");
}

export function computeCodeChallenge(verifier: string): string {
  const shaHex = createHash("sha256").update(verifier, "utf8").digest("hex");
  return Buffer.from(shaHex, "utf8").toString("base64url");
}

// ----- Auth endpoints -----

export async function getLoginParams(
  cfg: HttpConfig,
  email: string,
  codeChallenge: string,
  // Server-side, MFA is verified inside the /v2/login-params handler
  // (BaseAuthController.pkceParams calls verifyMFA before returning key
  // params), NOT inside /v2/login. So on an mfa-required failure the client
  // must re-call THIS endpoint with `{ [mfa_key]: code }` in the body — that
  // is what `extraBody` carries. Empty/omitted = first attempt.
  extraBody?: Record<string, string>,
): Promise<LoginParamsResponse> {
  const body = await snFetch<LoginParamsResponse>(
    `${cfg.serverUrl}/v2/login-params`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        api: "20200115",
        code_challenge: codeChallenge,
        ...extraBody,
      }),
    },
  );
  if (body.version !== "004" || !body.pw_nonce || !body.identifier) {
    throw new Error(
      "Account is not on protocol 004 or server returned unexpected shape. " +
        "Upgrade via the Standard Notes app and retry.",
    );
  }
  return body;
}

export async function login(
  cfg: HttpConfig,
  email: string,
  serverPassword: string,
  codeVerifier: string,
): Promise<LoginResponse> {
  // The server does NOT re-verify MFA at /v2/login (pkceSignIn skips
  // verifyMFA — see BaseAuthController). MFA is gated upstream at
  // /v2/login-params; once we've cleared it there, this call carries no
  // MFA payload.
  const payload: Record<string, unknown> = {
    email,
    password: serverPassword,
    code_verifier: codeVerifier,
    api: "20200115",
    ephemeral: false,
  };
  return snFetch<LoginResponse>(`${cfg.serverUrl}/v2/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function sync(
  cfg: HttpConfig & { authToken: string },
  params: {
    syncToken?: string;
    cursorToken?: string;
    limit?: number;
    items?: unknown[];
  },
): Promise<SyncResponse> {
  const payload: Record<string, unknown> = {
    api: "20200115",
    limit: params.limit ?? 150,
    items: params.items ?? [],
  };
  if (params.syncToken) payload["sync_token"] = params.syncToken;
  if (params.cursorToken) payload["cursor_token"] = params.cursorToken;

  const res = await snFetch<SyncResponse>(`${cfg.serverUrl}/v1/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.authToken}`,
    },
    body: JSON.stringify(payload),
  });
  logger.debug("sync page", {
    retrieved: res.retrieved_items?.length ?? 0,
    saved: res.saved_items?.length ?? 0,
    hasCursor: Boolean(res.cursor_token),
  });
  return {
    retrieved_items: res.retrieved_items ?? [],
    saved_items: res.saved_items ?? [],
    conflicts: res.conflicts ?? [],
    sync_token: res.sync_token,
    cursor_token: res.cursor_token,
    integrity_hash: res.integrity_hash,
  };
}

export async function refreshSession(
  cfg: HttpConfig,
  accessToken: string,
  refreshToken: string,
): Promise<SessionTokens> {
  return snFetch<SessionTokens>(`${cfg.serverUrl}/v1/sessions/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      api: "20200115",
    }),
  });
}
