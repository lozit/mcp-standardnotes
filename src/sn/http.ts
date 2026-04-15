import { createHash, randomBytes } from "node:crypto";
import { Agent, type Dispatcher } from "undici";
import { logger } from "../security/logger.js";
import type { KeyParams004 } from "./protocol004.js";

export interface HttpConfig {
  serverUrl: string;
  authToken?: string;
}

let pinnedDispatcher: Dispatcher | undefined;
let pinnedDispatcherInitialized = false;

function getPinnedDispatcher(): Dispatcher | undefined {
  if (pinnedDispatcherInitialized) return pinnedDispatcher;
  pinnedDispatcherInitialized = true;
  const expected = process.env.SN_CERT_FINGERPRINT;
  if (!expected) return undefined;
  const expectedNorm = expected.replace(/:/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedNorm)) {
    throw new Error(
      "SN_CERT_FINGERPRINT must be a SHA-256 fingerprint (64 hex chars, colons optional)",
    );
  }
  pinnedDispatcher = new Agent({
    connect: {
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
    },
  });
  logger.info("TLS cert pinning enabled via SN_CERT_FINGERPRINT");
  return pinnedDispatcher;
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

interface SnEnvelope<T> {
  meta?: unknown;
  data?: T & {
    error?: { tag?: string; message?: string; payload?: unknown };
  };
}

async function snFetch<T>(url: string, init: RequestInit): Promise<T> {
  const dispatcher = getPinnedDispatcher();
  const finalInit = dispatcher
    ? ({ ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher })
    : init;
  const res = await fetch(url, finalInit);
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
    throw new Error(`Non-JSON response from ${url} (status ${res.status})`);
  }
  const data = body.data as SnEnvelope<T>["data"];
  if (!res.ok || data?.error) {
    const err = data?.error;
    throw new SnApiError(
      err?.message ?? `HTTP ${res.status}`,
      err?.tag,
      res.status,
      err?.payload,
    );
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
  mfa?: { mfaKey: string; code: string },
): Promise<LoginResponse> {
  const payload: Record<string, unknown> = {
    email,
    password: serverPassword,
    code_verifier: codeVerifier,
    api: "20200115",
    ephemeral: false,
  };
  if (mfa) payload[mfa.mfaKey] = mfa.code;
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
