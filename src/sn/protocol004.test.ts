import { describe, expect, it } from "vitest";
import { randomBytes, sodiumReady, toHex } from "./crypto.js";
import {
  decryptItemsKey,
  decryptNote,
  deriveRootKey,
  encryptNote,
  encryptString,
  parseEncryptedString,
  decryptString,
  generateItemsKeyRaw,
  type KeyParams004,
} from "./protocol004.js";

describe("protocol004 primitives", () => {
  it("round-trips encryptString/decryptString with AAD", async () => {
    await sodiumReady();
    const key = await randomBytes(32);
    const uuid = "11111111-1111-4111-8111-111111111111";
    const ct = await encryptString("hello world", key, { u: uuid, v: "004", kp: "k" });
    const pt = await decryptString(ct, key, uuid);
    expect(pt).toBe("hello world");
  });

  it("detects wrong uuid in AAD", async () => {
    const key = await randomBytes(32);
    const ct = await encryptString("x", key, {
      u: "11111111-1111-4111-8111-111111111111",
      v: "004",
      kp: "k",
    });
    await expect(
      decryptString(ct, key, "22222222-2222-4222-8222-222222222222"),
    ).rejects.toThrow(/AAD uuid mismatch/);
  });

  it("parseEncryptedString rejects wrong format", async () => {
    await expect(parseEncryptedString("003:a:b:c")).rejects.toThrow(/version/);
    await expect(parseEncryptedString("004:a:b")).rejects.toThrow(/4 or 5/);
    await expect(parseEncryptedString("004_Asym:a:b:c")).rejects.toThrow(
      /Asymmetric/,
    );
  });

  it("parses 5-part payload with additionalData", async () => {
    await sodiumReady();
    const key = await randomBytes(32);
    const uuid = "11111111-1111-4111-8111-111111111111";
    const ct = await (
      await import("./protocol004.js")
    ).encryptString("x", key, { u: uuid, v: "004", kp: "k" });
    expect(ct.split(":").length).toBe(5);
    const parsed = await parseEncryptedString(ct);
    expect(parsed.additionalDataB64).toBe("e30=");
  });

  it("deriveRootKey produces 32-byte master key and hex server password", async () => {
    const params: KeyParams004 = {
      version: "004",
      identifier: "user@example.com",
      pw_nonce: "deadbeef".repeat(8),
    };
    const rk = await deriveRootKey("correct horse battery staple", params);
    expect(rk.masterKey.length).toBe(32);
    expect(rk.serverPassword).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses non-004 protocol", async () => {
    const params = {
      version: "003",
      identifier: "u",
      pw_nonce: "x",
    } as unknown as KeyParams004;
    await expect(deriveRootKey("pw", params)).rejects.toThrow(/004/);
  });

  it("round-trips a note through encryptNote → decryptNote", async () => {
    await sodiumReady();
    const itemsKeyBytes = await generateItemsKeyRaw();
    const itemsKeyUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const noteUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const encrypted = await encryptNote(
      { uuid: noteUuid, title: "My title", text: "My body text", trashed: false },
      { uuid: itemsKeyUuid, itemsKey: itemsKeyBytes },
    );

    const fakeRaw = {
      uuid: noteUuid,
      content_type: "Note",
      content: encrypted.content,
      enc_item_key: encrypted.enc_item_key,
      items_key_id: encrypted.items_key_id,
      created_at: "",
      updated_at: "",
    };
    const keyMap = new Map<string, Uint8Array>([[itemsKeyUuid, itemsKeyBytes]]);
    const dec = await decryptNote(fakeRaw, keyMap);
    expect(dec.title).toBe("My title");
    expect(dec.text).toBe("My body text");
    expect(dec.trashed).toBe(false);
  });

  it("round-trips an items_key (wrapping key + content.itemsKey)", async () => {
    await sodiumReady();
    const masterKey = await randomBytes(32);
    const wrappingKey = await generateItemsKeyRaw(); // K1
    const realItemsKey = await generateItemsKeyRaw(); // K2
    const itemsKeyUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const aad = { u: itemsKeyUuid, v: "004", kp: { version: "004" } };

    // enc_item_key: hex(K1) encrypted under masterKey
    const enc_item_key = await encryptString(await toHex(wrappingKey), masterKey, aad);
    // content: {itemsKey: hex(K2), ...} encrypted under K1
    const content = await encryptString(
      JSON.stringify({ version: "004", itemsKey: await toHex(realItemsKey) }),
      wrappingKey,
      aad,
    );

    const fakeRootKey = {
      masterKey,
      serverPassword: "00".repeat(32),
      keyParams: { version: "004" as const, identifier: "u", pw_nonce: "n" },
    };
    const k = await decryptItemsKey(
      {
        uuid: itemsKeyUuid,
        content_type: "SN|ItemsKey",
        content,
        enc_item_key,
      },
      fakeRootKey,
    );
    expect(k.uuid).toBe(itemsKeyUuid);
    expect(await toHex(k.itemsKey)).toBe(await toHex(realItemsKey));
  });

  it("raises a named error (not a bare SyntaxError) when decrypted content isn't JSON", async () => {
    await sodiumReady();
    const masterKey = await randomBytes(32);
    const wrappingKey = await generateItemsKeyRaw();
    const itemsKeyUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const aad = { u: itemsKeyUuid, v: "004", kp: { version: "004" } };

    const enc_item_key = await encryptString(
      await toHex(wrappingKey),
      masterKey,
      aad,
    );
    // Correctly AEAD-sealed (authentic) but the plaintext is not valid JSON.
    const content = await encryptString("definitely not json", wrappingKey, aad);

    const fakeRootKey = {
      masterKey,
      serverPassword: "00".repeat(32),
      keyParams: { version: "004" as const, identifier: "u", pw_nonce: "n" },
    };
    await expect(
      decryptItemsKey(
        { uuid: itemsKeyUuid, content_type: "SN|ItemsKey", content, enc_item_key },
        fakeRootKey,
      ),
    ).rejects.toThrow(/items_key content for .* is not valid JSON/);
  });
});
