import keytar from "keytar";

const SERVICE = process.env.KEYCHAIN_SERVICE ?? "mcp-standardnotes";

export interface StoredSession {
  serverUrl: string;
  email: string;
  sessionPayload: {
    access_token: string;
    refresh_token: string;
  };
  /** Hex-encoded 32-byte root master key. Required for local decryption on resume. */
  masterKeyHex: string;
  keyParams: unknown;
  savedAt: string;
}

export async function saveSession(
  email: string,
  session: StoredSession,
): Promise<void> {
  if (!email) throw new Error("email required");
  await keytar.setPassword(SERVICE, email, JSON.stringify(session));
}

export async function loadSession(
  email: string,
): Promise<StoredSession | null> {
  if (!email) throw new Error("email required");
  const raw = await keytar.getPassword(SERVICE, email);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    throw new Error("Stored session is corrupt; run `npm run login` again.");
  }
}

export async function deleteSession(email: string): Promise<boolean> {
  return keytar.deletePassword(SERVICE, email);
}
