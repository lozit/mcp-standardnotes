const SENSITIVE_KEY_RE =
  /\b(password|pw|mk|ak|masterKey|rootKey|itemsKey|authKey|serverPassword|session|accessToken|refreshToken|jwt|authorization)\b/i;

const LONG_TOKEN_RE = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;

const MAX_DEPTH = 8;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[depth-limit]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.replace(LONG_TOKEN_RE, "[REDACTED]");
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export function redactString(s: string): string {
  return s.replace(LONG_TOKEN_RE, "[REDACTED]");
}
