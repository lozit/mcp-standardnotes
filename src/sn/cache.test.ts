import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheTtlMs, DEFAULT_CACHE_TTL_MS, ensureFresh } from "./cache.js";

// Pin the clock so age math is deterministic. Vitest's fake timers control
// Date.now(), which is what ensureFresh reads.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureFresh", () => {
  it("triggers refresh on cold state (lastSyncAt = 0)", async () => {
    const state = { lastSyncAt: 0 };
    const refresh = vi.fn(async () => {});
    await ensureFresh(state, 30_000, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("skips refresh when cache is fresher than TTL", async () => {
    const state = { lastSyncAt: Date.now() - 5_000 }; // 5s ago
    const refresh = vi.fn(async () => {});
    await ensureFresh(state, 30_000, refresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("triggers refresh when cache is older than TTL", async () => {
    const state = { lastSyncAt: Date.now() - 31_000 }; // 31s ago, TTL 30s
    const refresh = vi.fn(async () => {});
    await ensureFresh(state, 30_000, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("maxAgeMs = 0 forces refresh even on a fresh cache", async () => {
    // Used by mutating operations (updateNote, deleteTag, …) to guarantee
    // we're never writing on top of a stale local snapshot.
    const state = { lastSyncAt: Date.now() - 100 }; // 100ms ago
    const refresh = vi.fn(async () => {});
    await ensureFresh(state, 0, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("maxAgeMs < 0 disables refresh entirely (legacy rollback)", async () => {
    // SN_CACHE_TTL_MS=-1 turns the whole fix into a no-op, restoring
    // pre-fix "sync only at boot" behavior. Useful escape hatch if a
    // regression shows up in the field.
    const state = { lastSyncAt: 0 }; // never synced
    const refresh = vi.fn(async () => {});
    await ensureFresh(state, -1, refresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("propagates errors thrown by refresh (does NOT swallow)", async () => {
    // A refresh failure right before a write MUST bubble up so the caller
    // aborts, rather than silently mutating on a stale snapshot.
    const state = { lastSyncAt: 0 };
    const refresh = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(ensureFresh(state, 30_000, refresh)).rejects.toThrow(/network down/);
  });

  it("boundary: age exactly equal to maxAgeMs does NOT trigger refresh", async () => {
    // Semantic: we refresh strictly when age > maxAgeMs. Ensures a TTL of
    // 30s means "at most 30s old", not "at least 30s old".
    const state = { lastSyncAt: Date.now() - 30_000 };
    const refresh = vi.fn(async () => {});
    await ensureFresh(state, 30_000, refresh);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("cacheTtlMs", () => {
  const original = process.env.SN_CACHE_TTL_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.SN_CACHE_TTL_MS;
    else process.env.SN_CACHE_TTL_MS = original;
  });

  it("returns the default when the env var is absent", () => {
    delete process.env.SN_CACHE_TTL_MS;
    expect(cacheTtlMs()).toBe(DEFAULT_CACHE_TTL_MS);
  });

  it("returns the default when the env var is empty string", () => {
    process.env.SN_CACHE_TTL_MS = "";
    expect(cacheTtlMs()).toBe(DEFAULT_CACHE_TTL_MS);
  });

  it("parses a numeric env var", () => {
    process.env.SN_CACHE_TTL_MS = "5000";
    expect(cacheTtlMs()).toBe(5000);
  });

  it("accepts 0 (strict per-call sync)", () => {
    process.env.SN_CACHE_TTL_MS = "0";
    expect(cacheTtlMs()).toBe(0);
  });

  it("accepts -1 (disable refresh)", () => {
    process.env.SN_CACHE_TTL_MS = "-1";
    expect(cacheTtlMs()).toBe(-1);
  });

  it("falls back to default when the env var is not a number (resilient boot)", () => {
    process.env.SN_CACHE_TTL_MS = "not-a-number";
    expect(cacheTtlMs()).toBe(DEFAULT_CACHE_TTL_MS);
  });
});
