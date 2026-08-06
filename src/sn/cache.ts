/**
 * Local vault cache staleness policy.
 *
 * The SN client keeps decrypted notes/tags in memory and, historically,
 * only did a fullSync at process startup. When two long-running instances
 * of the server target the same account (e.g. a local CLI lane + a
 * remote Hermes lane), each is blind to the other's writes and can even
 * overwrite a newer revision with a stale one — see
 * `intakes/mcp-standardnotes-cache-staleness.md`.
 *
 * `ensureFresh` is the single choke-point that decides "do I need to
 * refresh the cache before serving this call?" — TTL for reads, forced
 * for writes.
 */

export const DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * TTL (ms) used by read-side ensureFresh calls. Overridable via
 * `SN_CACHE_TTL_MS`. Special values:
 *   0  → refresh before every read (strict, one extra roundtrip per call)
 *   -1 → never refresh (legacy "sync only at boot" behavior, kept as an
 *        emergency rollback lever)
 *
 * A non-numeric value falls back to the default rather than throwing,
 * to keep boot resilient to a fat-fingered env var.
 */
export function cacheTtlMs(): number {
  const raw = process.env.SN_CACHE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_CACHE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_CACHE_TTL_MS;
}

export interface Freshness {
  /** ms timestamp of the last successful refresh, 0 if never. */
  lastSyncAt: number;
}

/**
 * Trigger `refresh()` if the cache is older than maxAgeMs. Semantics:
 *   maxAgeMs <  0 → never refresh (caller opt-out)
 *   maxAgeMs == 0 → always refresh (caller wants unconditional freshness,
 *                    e.g. before a write)
 *   maxAgeMs >  0 → refresh only when `now - lastSyncAt > maxAgeMs`
 *
 * The function does NOT set `lastSyncAt` itself — that's `refresh()`'s
 * job (it typically calls the full sync routine, which owns the state
 * and updates it once the sync succeeds). This split keeps `ensureFresh`
 * testable without pulling in the whole client machinery.
 */
export async function ensureFresh(
  state: Freshness,
  maxAgeMs: number,
  refresh: () => Promise<void>,
): Promise<void> {
  if (maxAgeMs < 0) return;
  const ageMs = Date.now() - state.lastSyncAt;
  if (maxAgeMs === 0 || ageMs > maxAgeMs) {
    await refresh();
  }
}
