import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptItemContent003, decryptString003, type LegacyItemsKey } from "./protocol003.js";
import { decryptNote, decryptTag, type EncryptedItemInput } from "./protocol004.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const KEY_UUID = "33333333-3333-4333-8333-333333333333";

// Test-only encoder written from the published 003 format, independent of the decryptor.
function enc003(plain: string, ekHex: string, akHex: string, uuid: string, extra?: string): string {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", Buffer.from(ekHex, "hex"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
  const ivHex = iv.toString("hex");
  const mac = createHmac("sha256", Buffer.from(akHex, "hex")).update(`003:${uuid}:${ivHex}:${ct}`).digest("hex");
  return ["003", mac, uuid, ivHex, ct, ...(extra ? [extra] : [])].join(":");
}

const hex32 = () => randomBytes(32).toString("hex");

function legacyKey(ekHex: string, akHex: string, uuid = KEY_UUID): LegacyItemsKey {
  return {
    uuid,
    itemsKey: Buffer.from(ekHex, "hex"),
    dataAuthenticationKey: Buffer.from(akHex, "hex"),
    version: "003",
  };
}

// A synthetic 003 item: per-item key (ek || ak) wrapped under a 003 items key.
function legacyItem(
  content: Record<string, unknown>,
  opts: { uuid?: string; contentType?: string; embeddedUuid?: string; extra?: string; itemsKeyId?: string } = {},
) {
  const uuid = opts.uuid ?? UUID;
  const embedded = opts.embeddedUuid ?? uuid;
  const keyEk = hex32(), keyAk = hex32(), itemEk = hex32(), itemAk = hex32();
  const item: EncryptedItemInput = {
    uuid,
    content_type: opts.contentType ?? "Note",
    content: enc003(JSON.stringify(content), itemEk, itemAk, embedded, opts.extra),
    enc_item_key: enc003(itemEk + itemAk, keyEk, keyAk, embedded, opts.extra),
    items_key_id: opts.itemsKeyId ?? null,
  };
  return { item, key: legacyKey(keyEk, keyAk), keyEk, keyAk, itemEk, itemAk };
}

describe("decryptString003", () => {
  it("decrypts a 5-part payload", async () => {
    const f = legacyItem({ text: "x" });
    expect(await decryptString003(f.item.enc_item_key, { ek: f.key.itemsKey, ak: f.key.dataAuthenticationKey }, UUID))
      .toBe(f.itemEk + f.itemAk);
  });

  it("returns null when the MAC does not verify (wrong key or tampering)", async () => {
    const f = legacyItem({ text: "x" });
    const wrongAk = { ek: f.key.itemsKey, ak: Buffer.from(hex32(), "hex") };
    expect(await decryptString003(f.item.enc_item_key, wrongAk, UUID)).toBeNull();
    const parts = f.item.enc_item_key.split(":");
    parts[4] = Buffer.from("tampered").toString("base64");
    const key = { ek: f.key.itemsKey, ak: f.key.dataAuthenticationKey };
    expect(await decryptString003(parts.join(":"), key, UUID)).toBeNull();
  });

  it("refuses authentic ciphertext moved onto another item", async () => {
    const f = legacyItem({ text: "x" });
    const key = { ek: f.key.itemsKey, ak: f.key.dataAuthenticationKey };
    await expect(decryptString003(f.item.enc_item_key, key, OTHER)).rejects.toThrow(/uuid mismatch/);
  });

  it("rejects malformed payloads", async () => {
    const key = { ek: Buffer.alloc(32), ak: Buffer.alloc(32) };
    for (const bad of ["003:aa:bb", "004:a:b:c:d", `003:${"0".repeat(64)}:${UUID}:zz:abc`, "003:1:2:3:4:5:6"]) {
      await expect(decryptString003(bad, key, UUID)).rejects.toThrow(/Invalid 003 payload/);
    }
  });
});

describe("decryptItemContent003", () => {
  it("ignores the unauthenticated 6th segment (account key params)", async () => {
    const f = legacyItem({ text: "legacy body" }, { extra: Buffer.from('{"identifier":"x"}').toString("base64") });
    expect(f.item.content.split(":")).toHaveLength(6);
    expect(JSON.parse(await decryptItemContent003(f.item, [f.key]))).toEqual({ text: "legacy body" });
  });

  it("tries every legacy key for items without items_key_id", async () => {
    const f = legacyItem({ text: "legacy body" });
    const decoy = legacyKey(hex32(), hex32(), OTHER);
    expect(JSON.parse(await decryptItemContent003(f.item, [decoy, f.key]))).toEqual({ text: "legacy body" });
  });

  it("uses only the referenced key when items_key_id is set", async () => {
    const f = legacyItem({ text: "x" }, { itemsKeyId: OTHER });
    await expect(decryptItemContent003(f.item, [f.key])).rejects.toThrow(/No 003 items_key/);
    expect(JSON.parse(await decryptItemContent003(f.item, [{ ...f.key, uuid: OTHER }]))).toEqual({ text: "x" });
  });

  it("fails when no legacy key authenticates the item", async () => {
    const f = legacyItem({ text: "x" });
    await expect(decryptItemContent003(f.item, [legacyKey(hex32(), hex32())])).rejects.toThrow(/No 003 items_key authenticates/);
    await expect(decryptItemContent003(f.item, [])).rejects.toThrow(/No 003 items_key/);
  });

  it("refuses an item whose embedded uuid differs from the server uuid", async () => {
    const f = legacyItem({ text: "x" }, { embeddedUuid: OTHER });
    await expect(decryptItemContent003(f.item, [f.key])).rejects.toThrow(/uuid mismatch/);
  });

  it("fails when the content MAC does not verify under the item key", async () => {
    const f = legacyItem({ text: "x" });
    const other = legacyItem({ text: "y" });
    await expect(decryptItemContent003({ ...f.item, content: other.item.content }, [f.key]))
      .rejects.toThrow(/failed authentication/);
  });
});

describe("decryptNote / decryptTag with 003 items", () => {
  it("decrypts a legacy note and tag through the shared 004 entry points", async () => {
    const note = legacyItem({ title: "Old", text: "legacy body", references: [], protected: true });
    const n = await decryptNote(note.item, new Map(), [note.key]);
    expect(n).toMatchObject({ uuid: UUID, title: "Old", text: "legacy body", protected: true, noteType: "plain-text" });

    const tag = legacyItem(
      { title: "Archive", references: [{ uuid: UUID, content_type: "Note" }] },
      { uuid: OTHER, contentType: "Tag" },
    );
    expect(await decryptTag(tag.item, new Map(), [tag.key]))
      .toMatchObject({ title: "Archive", references: [{ uuid: UUID, content_type: "Note" }] });
  });

  it("fails without legacy keys, as before", async () => {
    const note = legacyItem({ text: "x" });
    await expect(decryptNote(note.item, new Map())).rejects.toThrow(/No 003 items_key/);
  });
});
