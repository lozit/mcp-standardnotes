import { describe, expect, it } from "vitest";
import type { DecryptedTag } from "./protocol004.js";
import {
  makeParentRef,
  parentUuidOf,
  stripParentRefs,
  subtreeTagUuids,
  wouldCreateCycle,
} from "./tagHierarchy.js";

function tag(over: Partial<DecryptedTag> & { uuid: string }): DecryptedTag {
  return {
    uuid: over.uuid,
    title: over.title ?? "",
    references: over.references ?? [],
    createdAt: over.createdAt ?? "",
    updatedAt: over.updatedAt ?? "",
    created_at_timestamp: over.created_at_timestamp ?? 0,
    updated_at_timestamp: over.updated_at_timestamp ?? 0,
  };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";

function parentRef(uuid: string) {
  return {
    uuid,
    content_type: "SN|Tag",
    reference_type: "TagToParentTag",
  };
}

describe("parentUuidOf", () => {
  it("returns null when there is no parent link", () => {
    expect(parentUuidOf(tag({ uuid: A }))).toBeNull();
  });

  it("reads a modern TagToParentTag reference", () => {
    const t = tag({
      uuid: A,
      references: [
        { uuid: B, content_type: "SN|Tag", reference_type: "TagToParentTag" },
      ],
    });
    expect(parentUuidOf(t)).toBe(B);
  });

  it("accepts a legacy SN|Tag reference without reference_type", () => {
    const t = tag({
      uuid: A,
      references: [{ uuid: B, content_type: "SN|Tag" }],
    });
    expect(parentUuidOf(t)).toBe(B);
  });

  it("ignores a SN|Tag reference whose reference_type is something else", () => {
    // Guards against future reference types (e.g. TagToFile written with
    // content_type SN|Tag by mistake) being misread as parent links.
    const t = tag({
      uuid: A,
      references: [
        { uuid: B, content_type: "SN|Tag", reference_type: "TagToFile" },
      ],
    });
    expect(parentUuidOf(t)).toBeNull();
  });

  it("skips non-tag references and finds the parent among them", () => {
    const t = tag({
      uuid: A,
      references: [
        { uuid: "note-1", content_type: "Note" },
        { uuid: B, content_type: "SN|Tag", reference_type: "TagToParentTag" },
      ],
    });
    expect(parentUuidOf(t)).toBe(B);
  });
});

describe("stripParentRefs", () => {
  it("removes both modern and legacy parent references, preserves the rest", () => {
    const refs = [
      { uuid: "note-1", content_type: "Note" },
      { uuid: B, content_type: "SN|Tag", reference_type: "TagToParentTag" },
      { uuid: C, content_type: "SN|Tag" },
    ];
    expect(stripParentRefs(refs)).toEqual([
      { uuid: "note-1", content_type: "Note" },
    ]);
  });

  it("keeps a SN|Tag reference with a non-parent reference_type", () => {
    const refs = [
      { uuid: B, content_type: "SN|Tag", reference_type: "TagToFile" },
    ];
    expect(stripParentRefs(refs)).toEqual(refs);
  });
});

describe("makeParentRef", () => {
  it("emits the shape SN clients expect on the wire", () => {
    expect(makeParentRef(B)).toEqual({
      uuid: B,
      content_type: "SN|Tag",
      reference_type: "TagToParentTag",
    });
  });
});

describe("subtreeTagUuids", () => {
  it("returns just the root uuid for a leaf tag", () => {
    const tree = new Map<string, DecryptedTag>([[A, tag({ uuid: A })]]);
    expect(subtreeTagUuids(tree, A)).toEqual(new Set([A]));
  });

  it("returns an empty set when the root is unknown", () => {
    // Guards `notes_list { tag: X, includeDescendants: true }` from
    // walking a dangling UUID and returning phantom results.
    const tree = new Map<string, DecryptedTag>([[A, tag({ uuid: A })]]);
    expect(subtreeTagUuids(tree, "unknown-uuid")).toEqual(new Set());
  });

  it("collects the root and all direct children", () => {
    // Tree: A → { B, C }
    const tree = new Map<string, DecryptedTag>([
      [A, tag({ uuid: A })],
      [B, tag({ uuid: B, references: [parentRef(A)] })],
      [C, tag({ uuid: C, references: [parentRef(A)] })],
    ]);
    expect(subtreeTagUuids(tree, A)).toEqual(new Set([A, B, C]));
  });

  it("walks depth-3 subtrees", () => {
    // A → B → C → D  (linear); E is unrelated
    const tree = new Map<string, DecryptedTag>([
      [A, tag({ uuid: A })],
      [B, tag({ uuid: B, references: [parentRef(A)] })],
      [C, tag({ uuid: C, references: [parentRef(B)] })],
      [D, tag({ uuid: D, references: [parentRef(C)] })],
      [E, tag({ uuid: E })],
    ]);
    expect(subtreeTagUuids(tree, A)).toEqual(new Set([A, B, C, D]));
    // Sub-root: only its own subtree.
    expect(subtreeTagUuids(tree, C)).toEqual(new Set([C, D]));
    // Unrelated tag returns only itself.
    expect(subtreeTagUuids(tree, E)).toEqual(new Set([E]));
  });

  it("does not infinite-loop on a pre-existing cycle in the vault", () => {
    // A ↔ B mutually parented (data corruption). Still terminates and
    // returns both, so notes_list can at least surface something usable.
    const tree = new Map<string, DecryptedTag>([
      [A, tag({ uuid: A, references: [parentRef(B)] })],
      [B, tag({ uuid: B, references: [parentRef(A)] })],
    ]);
    const out = subtreeTagUuids(tree, A);
    expect(out.has(A)).toBe(true);
    expect(out.has(B)).toBe(true);
    expect(out.size).toBe(2);
  });
});

describe("wouldCreateCycle", () => {
  // Tree: A → B → C (C is B's parent, B is A's parent)
  const tree = new Map<string, DecryptedTag>([
    [
      A,
      tag({
        uuid: A,
        references: [
          { uuid: B, content_type: "SN|Tag", reference_type: "TagToParentTag" },
        ],
      }),
    ],
    [
      B,
      tag({
        uuid: B,
        references: [
          { uuid: C, content_type: "SN|Tag", reference_type: "TagToParentTag" },
        ],
      }),
    ],
    [C, tag({ uuid: C })],
  ]);

  it("refuses making a tag its own parent", () => {
    expect(wouldCreateCycle(tree, A, A)).toBe(true);
  });

  it("refuses re-parenting under a direct descendant", () => {
    // C wants B as parent, but B is a descendant of C in this tree.
    expect(wouldCreateCycle(tree, C, B)).toBe(true);
  });

  it("refuses re-parenting under a transitive descendant", () => {
    // C wants A as parent, but A is a grandchild of C.
    expect(wouldCreateCycle(tree, C, A)).toBe(true);
  });

  it("allows re-parenting under an unrelated tag", () => {
    // A wants C as parent — already the case indirectly, but no cycle.
    expect(wouldCreateCycle(tree, A, C)).toBe(false);
  });

  it("allows attaching under a brand-new top-level tag", () => {
    expect(wouldCreateCycle(tree, C, "unknown-uuid")).toBe(false);
  });

  it("does not infinite-loop on a pre-existing cycle in the vault", () => {
    // A → B → A (data corruption). Re-parenting elsewhere must still be
    // decidable so a user can repair the tree.
    const corrupt = new Map<string, DecryptedTag>([
      [
        A,
        tag({
          uuid: A,
          references: [
            {
              uuid: B,
              content_type: "SN|Tag",
              reference_type: "TagToParentTag",
            },
          ],
        }),
      ],
      [
        B,
        tag({
          uuid: B,
          references: [
            {
              uuid: A,
              content_type: "SN|Tag",
              reference_type: "TagToParentTag",
            },
          ],
        }),
      ],
    ]);
    // C is fresh — not involved in the corrupted loop, so no NEW cycle would
    // be created by making it a child of A.
    expect(wouldCreateCycle(corrupt, C, A)).toBe(false);
  });
});
