import { describe, expect, it } from "vitest";
import { redact, redactString } from "./redact.js";

describe("redact", () => {
  it("redacts sensitive keys case-insensitively", () => {
    expect(redact({ password: "hunter2", title: "ok" })).toEqual({
      password: "[REDACTED]",
      title: "ok",
    });
    expect(redact({ RootKey: "abc", Session: "def" })).toEqual({
      RootKey: "[REDACTED]",
      Session: "[REDACTED]",
    });
  });

  it("redacts long token-like strings in values", () => {
    const token = "abcdef0123456789ABCDEF0123456789abcdef";
    expect(redact({ note: `token=${token} end` })).toEqual({
      note: "token=[REDACTED] end",
    });
  });

  it("recurses into arrays and nested objects", () => {
    expect(
      redact({
        items: [{ authKey: "x", label: "keep" }],
        safe: "value",
      }),
    ).toEqual({
      items: [{ authKey: "[REDACTED]", label: "keep" }],
      safe: "value",
    });
  });

  it("caps recursion depth", () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 20; i++) {
      const next: Record<string, unknown> = {};
      cur.next = next;
      cur = next;
    }
    expect(() => redact(deep)).not.toThrow();
  });

  it("passes through primitives", () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it("redactString masks long tokens only", () => {
    expect(redactString("short ok")).toBe("short ok");
    expect(redactString("x ".repeat(5) + "A".repeat(40))).toContain(
      "[REDACTED]",
    );
  });
});
