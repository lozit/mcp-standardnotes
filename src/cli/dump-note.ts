import { loadSession } from "../sn/session.js";
import * as http from "../sn/http.js";
import {
  decryptString,
  type KeyParams004,
  type RootKey,
} from "../sn/protocol004.js";
import { fromHex, sodiumReady } from "../sn/crypto.js";

async function main(): Promise<void> {
  await sodiumReady();
  const email = process.env.SN_EMAIL;
  const needle = process.argv[2];
  if (!email) throw new Error("SN_EMAIL env required");
  if (!needle)
    throw new Error("Usage: npm run dump-note -- <uuid-or-title-substring>");

  const stored = await loadSession(email);
  if (!stored) throw new Error("No session in keychain; run `npm run login`");

  const rootKey: RootKey = {
    masterKey: await fromHex(stored.masterKeyHex),
    serverPassword: "",
    keyParams: stored.keyParams as KeyParams004,
  };

  const raw: http.RawItem[] = [];
  let cursorToken: string | undefined;
  let syncToken: string | undefined;
  while (true) {
    const res = await http.sync(
      {
        serverUrl: stored.serverUrl,
        authToken: stored.sessionPayload.access_token,
      },
      { syncToken, cursorToken, limit: 150 },
    );
    for (const it of res.retrieved_items) if (!it.deleted) raw.push(it);
    syncToken = res.sync_token;
    cursorToken = res.cursor_token;
    if (!cursorToken) break;
  }

  const ikBytes = new Map<string, Uint8Array>();
  for (const it of raw) {
    if (it.content_type !== "SN|ItemsKey") continue;
    const wrapHex = await decryptString(it.enc_item_key, rootKey.masterKey, it.uuid);
    const wrap = await fromHex(wrapHex);
    const contentJson = await decryptString(it.content, wrap, it.uuid);
    const parsed = JSON.parse(contentJson) as { itemsKey?: string };
    if (parsed.itemsKey) ikBytes.set(it.uuid, await fromHex(parsed.itemsKey));
  }

  const notes = raw.filter((i) => i.content_type === "Note");
  console.log(`Total notes on server: ${notes.length}`);

  for (const n of notes) {
    const keyId = n.items_key_id;
    if (!keyId) continue;
    const ik = ikBytes.get(keyId);
    if (!ik) continue;
    const perHex = await decryptString(n.enc_item_key, ik, n.uuid);
    const per = await fromHex(perHex);
    const contentJson = await decryptString(n.content, per, n.uuid);
    let title = "";
    try {
      title = (JSON.parse(contentJson) as { title?: string }).title ?? "";
    } catch {
      // ignore
    }
    const match =
      n.uuid.includes(needle) ||
      title.toLowerCase().includes(needle.toLowerCase());
    if (!match) continue;

    console.log("\n=== MATCH ===");
    const redacted = { ...(n as unknown as Record<string, unknown>) };
    delete redacted.content;
    delete redacted.enc_item_key;
    console.log("--- raw item fields (content/enc_item_key omitted) ---");
    console.log(JSON.stringify(redacted, null, 2));
    const cParts = n.content.split(":");
    const eikParts = n.enc_item_key.split(":");
    const decode = (b64: string) =>
      Buffer.from(b64, "base64").toString("utf8");
    console.log("--- encrypted structure ---");
    console.log("content parts:", cParts.length);
    console.log("content[0] version:", cParts[0]);
    console.log("content[3] AAD JSON:", decode(cParts[3] ?? ""));
    console.log(
      "content[4] additional:",
      cParts[4] ? decode(cParts[4]) : "(missing)",
    );
    console.log("enc_item_key parts:", eikParts.length);
    console.log("enc_item_key[3] AAD JSON:", decode(eikParts[3] ?? ""));
    console.log(
      "enc_item_key[4] additional:",
      eikParts[4] ? decode(eikParts[4]) : "(missing)",
    );
    console.log("--- decrypted content JSON ---");
    try {
      console.log(JSON.stringify(JSON.parse(contentJson), null, 2));
    } catch {
      console.log(contentJson);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
