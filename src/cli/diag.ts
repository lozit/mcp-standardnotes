import readline from "node:readline";
import { createRequire } from "node:module";
import * as http from "../sn/http.js";
import { deriveRootKey, type KeyParams004 } from "../sn/protocol004.js";
import { fromBase64, fromHex, sodiumReady, toHex } from "../sn/crypto.js";

const req = createRequire(import.meta.url);
const sodium = req(
  "libsodium-wrappers-sumo",
) as typeof import("libsodium-wrappers-sumo");

function prompt(q: string, silent = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (silent) {
      const w = (rl as unknown as { _writeToOutput: (s: string) => void })
        ._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
        (s: string) => w.call(rl, s.trim().length === 0 ? s : "*");
    }
    rl.question(q, (a) => {
      rl.close();
      if (silent) process.stdout.write("\n");
      resolve(a.trim());
    });
  });
}

async function main(): Promise<void> {
  await sodiumReady();
  const serverUrl = process.env.SN_SERVER_URL ?? "https://api.standardnotes.com";
  const email = process.env.SN_EMAIL ?? (await prompt("Email: "));
  const password = await prompt("Password: ", true);

  const verifier = http.generateCodeVerifier();
  const challenge = http.computeCodeChallenge(verifier);
  const params = await http.getLoginParams({ serverUrl }, email, challenge);
  const kp: KeyParams004 = {
    version: "004",
    identifier: params.identifier,
    pw_nonce: params.pw_nonce,
  };
  const rootKey = await deriveRootKey(password, kp);
  console.log("masterKey len:", rootKey.masterKey.length);
  console.log("masterKey hex[0..8]:", (await toHex(rootKey.masterKey)).slice(0, 8));

  const loginRes = await http.login(
    { serverUrl },
    email,
    rootKey.serverPassword,
    verifier,
  );
  console.log("login OK, user:", loginRes.user.email);

  const sync = await http.sync(
    { serverUrl, authToken: loginRes.session.access_token },
    { limit: 10 },
  );
  const itemsKeys = sync.retrieved_items.filter(
    (i) => i.content_type === "SN|ItemsKey",
  );
  console.log("items_keys count:", itemsKeys.length);

  const notes = sync.retrieved_items.filter((i) => i.content_type === "Note");
  console.log("notes in first page:", notes.length);
  // First decrypt the items_keys so we have their bytes
  const ikBytes = new Map<string, Uint8Array>();
  for (const ik of itemsKeys) {
    const parts = ik.enc_item_key.split(":");
    const aad = new TextEncoder().encode(parts[3]!);
    const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      await fromBase64(parts[2]!),
      aad,
      await fromHex(parts[1]!),
      rootKey.masterKey,
    );
    ikBytes.set(ik.uuid, await fromHex(Buffer.from(pt).toString()));
  }

  for (const n of notes.slice(0, 1)) {
    console.log("\n### note", n.uuid.slice(0, 8), "###");
    console.log("  items_key_id on raw:", n.items_key_id);
    const ik = ikBytes.get(n.items_key_id!);
    if (!ik) { console.log("  no matching items_key"); continue; }

    const eikParts = n.enc_item_key.split(":");
    const cParts = n.content.split(":");

    // Try multiple strategies for enc_item_key
    const strategies: Array<[string, Uint8Array]> = [
      ["items_key bytes", ik],
      ["sha256(items_key)", sodium.crypto_hash_sha256(ik)],
      ["masterKey", rootKey.masterKey],
    ];
    for (const [label, key] of strategies) {
      try {
        const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          await fromBase64(eikParts[2]!),
          new TextEncoder().encode(eikParts[3]!),
          await fromHex(eikParts[1]!),
          key,
        );
        console.log(`  enc_item_key decrypt with [${label}] → OK, plaintext len=${pt.length}, sample=${Buffer.from(pt).toString().slice(0, 70)}`);

        // try decoding as hex → per-item-key, then decrypt content
        try {
          const perItem = await fromHex(Buffer.from(pt).toString());
          const contentPt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null,
            await fromBase64(cParts[2]!),
            new TextEncoder().encode(cParts[3]!),
            await fromHex(cParts[1]!),
            perItem,
          );
          console.log(`    → content decrypt with perItem (hex) → OK: ${Buffer.from(contentPt).toString().slice(0, 80)}`);
        } catch (e) { console.log(`    → content decrypt with perItem failed: ${(e as Error).message}`); }

        // try using the plaintext bytes directly as key (if pt is already 32 bytes)
        if (pt.length === 32) {
          try {
            const contentPt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
              null,
              await fromBase64(cParts[2]!),
              new TextEncoder().encode(cParts[3]!),
              await fromHex(cParts[1]!),
              pt,
            );
            console.log(`    → content decrypt with raw pt (32B) → OK: ${Buffer.from(contentPt).toString().slice(0, 80)}`);
          } catch { /* silent */ }
        }
      } catch (err) {
        console.log(`  enc_item_key with [${label}] failed: ${(err as Error).message}`);
      }
    }

    // Try direct: content encrypted with items_key, no per-item-key wrapping
    try {
      const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        await fromBase64(cParts[2]!),
        new TextEncoder().encode(cParts[3]!),
        await fromHex(cParts[1]!),
        ik,
      );
      console.log(`  DIRECT content + items_key → OK: ${Buffer.from(pt).toString().slice(0, 80)}`);
    } catch (err) {
      console.log(`  DIRECT content + items_key failed: ${(err as Error).message}`);
    }
  }

  for (const ik of itemsKeys.slice(0, 2)) {
    console.log("\n=== items_key", ik.uuid.slice(0, 8), "===");
    const parts = ik.enc_item_key.split(":");
    console.log("  enc_item_key parts:", parts.length);
    console.log("  part[0] (version):", parts[0]);
    console.log("  part[1] (nonce) length:", parts[1]?.length, "sample:", parts[1]?.slice(0, 8));
    console.log("  part[2] (ct) length:", parts[2]?.length);
    console.log("  part[3] (aad) length:", parts[3]?.length);
    console.log("  part[3] decoded:", Buffer.from(parts[3] ?? "", "base64").toString());
    if (parts[4]) console.log("  part[4] (addl) decoded:", Buffer.from(parts[4], "base64").toString());

    const nonce = await fromHex(parts[1]!);
    const ct = await fromBase64(parts[2]!);
    const aadDecoded = await fromBase64(parts[3]!);
    const aadRawBase64Bytes = new TextEncoder().encode(parts[3]!);
    const addlDecoded = parts[4] ? await fromBase64(parts[4]) : new Uint8Array();
    const addlRawBytes = parts[4] ? new TextEncoder().encode(parts[4]) : new Uint8Array();

    const concat = (a: Uint8Array, b: Uint8Array) => {
      const o = new Uint8Array(a.length + b.length);
      o.set(a);
      o.set(b, a.length);
      return o;
    };
    const concatStr = (a: Uint8Array, sep: string, b: Uint8Array) => {
      const s = new TextEncoder().encode(sep);
      return concat(concat(a, s), b);
    };

    const aadVariants: Array<[string, Uint8Array]> = [
      ["decoded-json", aadDecoded],
      ["raw-b64-ascii", aadRawBase64Bytes],
      ["decoded + decoded", concat(aadDecoded, addlDecoded)],
      ["raw-b64 : raw-b64", concatStr(aadRawBase64Bytes, ":", addlRawBytes)],
      ["decoded : decoded", concatStr(aadDecoded, ":", addlDecoded)],
      ["raw-b64 + raw-b64", concat(aadRawBase64Bytes, addlRawBytes)],
    ];

    for (const [label, aad] of aadVariants) {
      try {
        const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null, ct, aad, nonce, rootKey.masterKey,
        );
        console.log(`  AAD[${label}] + masterKey → OK:`, Buffer.from(pt).toString().slice(0, 60));
      } catch {
        // try alternate key: hex(masterKey) ASCII
        try {
          const hex = await toHex(rootKey.masterKey);
          const keyAscii = new TextEncoder().encode(hex).slice(0, 32);
          const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null, ct, aad, nonce, keyAscii,
          );
          console.log(`  AAD[${label}] + hexAscii[:32] → OK:`, Buffer.from(pt).toString().slice(0, 60));
        } catch {
          /* silent */
        }
      }
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
