import type { DecryptedTag, TagReference } from "./protocol004.js";

/**
 * Standard Notes stores tag folder hierarchy as a TagToParentTag reference
 * on the CHILD tag. See standardnotes/app packages/models .../Tag.ts
 * `parentId` getter and .../Reference/Functions.ts `isTagToParentTagReference`.
 *
 * Modern references carry `reference_type: "TagToParentTag"`. Payloads written
 * by older clients omit `reference_type` and just have `content_type: "SN|Tag"`;
 * historically that shape only ever meant "parent of" (there is no reverse
 * link from parent to children in SN), so we accept it.
 *
 * A reference with `reference_type` set to anything other than TagToParentTag
 * (e.g. TagToFile) is NOT a parent link even when content_type is SN|Tag —
 * so gate on the value, not just presence.
 */
export function parentUuidOf(t: DecryptedTag): string | null {
  for (const r of t.references) {
    if (r.reference_type === "TagToParentTag") return r.uuid;
    if (r.reference_type === undefined && r.content_type === "SN|Tag") {
      return r.uuid;
    }
  }
  return null;
}

export function stripParentRefs(refs: TagReference[]): TagReference[] {
  return refs.filter((r) => {
    if (r.reference_type === "TagToParentTag") return false;
    if (r.reference_type === undefined && r.content_type === "SN|Tag") {
      return false;
    }
    return true;
  });
}

export function makeParentRef(parentUuid: string): TagReference {
  return {
    uuid: parentUuid,
    content_type: "SN|Tag",
    reference_type: "TagToParentTag",
  };
}

/**
 * Would re-parenting `childUuid` under `newParentUuid` create a cycle?
 *
 * Walks up the ancestor chain from `newParentUuid`. If the walk ever visits
 * `childUuid`, the child is currently an ancestor of the proposed parent —
 * setting the link would close the loop. A pre-existing cycle in the vault
 * (data-corruption case) is detected and treated as "not our cycle" so a
 * legitimate re-parent can still repair a broken tree.
 */
export function wouldCreateCycle(
  tags: Map<string, DecryptedTag>,
  childUuid: string,
  newParentUuid: string,
): boolean {
  if (childUuid === newParentUuid) return true;
  let cursor: string | null = newParentUuid;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    if (cursor === childUuid) return true;
    const t = tags.get(cursor);
    cursor = t ? parentUuidOf(t) : null;
  }
  return false;
}
