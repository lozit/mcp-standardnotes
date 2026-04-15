import { describe, expect, it } from "vitest";
import { sodiumReady } from "./crypto.js";
import {
  decryptTag,
  encryptTag,
  generateItemsKeyRaw,
} from "./protocol004.js";

describe("protocol004 tags", () => {
  it("round-trips a tag through encryptTag → decryptTag", async () => {
    await sodiumReady();
    const itemsKeyBytes = await generateItemsKeyRaw();
    const itemsKeyUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const tagUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const noteUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const encrypted = await encryptTag(
      {
        uuid: tagUuid,
        title: "work",
        references: [{ uuid: noteUuid, content_type: "Note" }],
      },
      { uuid: itemsKeyUuid, itemsKey: itemsKeyBytes },
    );

    const fakeRaw = {
      uuid: tagUuid,
      content_type: "Tag",
      content: encrypted.content,
      enc_item_key: encrypted.enc_item_key,
      items_key_id: encrypted.items_key_id,
      created_at: "",
      updated_at: "",
    };
    const keyMap = new Map<string, Uint8Array>([[itemsKeyUuid, itemsKeyBytes]]);
    const dec = await decryptTag(fakeRaw, keyMap);
    expect(dec.title).toBe("work");
    expect(dec.references).toEqual([
      { uuid: noteUuid, content_type: "Note" },
    ]);
  });

  it("round-trips a tag with empty references", async () => {
    await sodiumReady();
    const itemsKeyBytes = await generateItemsKeyRaw();
    const itemsKeyUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const tagUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const encrypted = await encryptTag(
      { uuid: tagUuid, title: "empty", references: [] },
      { uuid: itemsKeyUuid, itemsKey: itemsKeyBytes },
    );
    const keyMap = new Map<string, Uint8Array>([[itemsKeyUuid, itemsKeyBytes]]);
    const dec = await decryptTag(
      {
        uuid: tagUuid,
        content_type: "Tag",
        content: encrypted.content,
        enc_item_key: encrypted.enc_item_key,
        items_key_id: encrypted.items_key_id,
      },
      keyMap,
    );
    expect(dec.title).toBe("empty");
    expect(dec.references).toEqual([]);
  });

  it("rejects tag with no items_key_id", async () => {
    const keyMap = new Map<string, Uint8Array>();
    await expect(
      decryptTag(
        {
          uuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          content_type: "Tag",
          content: "x",
          enc_item_key: "x",
        },
        keyMap,
      ),
    ).rejects.toThrow(/items_key_id/);
  });
});
