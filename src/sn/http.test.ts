import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("undici", () => ({
  fetch: fetchMock,
  Agent: class {
    constructor(_opts?: unknown) {}
  },
}));

import { getLoginParams, SnApiError } from "./http.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const validLoginParams = {
  data: { identifier: "a@b.co", pw_nonce: "nonce", version: "004" },
};

function lastRequestHeaders(): Headers {
  const init = fetchMock.mock.calls[0]?.[1] as { headers?: HeadersInit };
  return new Headers(init.headers);
}

describe("snFetch (via getLoginParams)", () => {
  afterEach(() => fetchMock.mockReset());

  it("sends a Chrome-like User-Agent so Cloudflare doesn't serve a JS challenge", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validLoginParams));

    await getLoginParams(
      { serverUrl: "https://api.standardnotes.com" },
      "a@b.co",
      "challenge",
    );

    expect(lastRequestHeaders().get("User-Agent")).toMatch(
      /Mozilla\/5\.0.*Chrome\//,
    );
  });

  it("identifies the real client via X-Client header (with version)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validLoginParams));

    await getLoginParams(
      { serverUrl: "https://api.standardnotes.com" },
      "a@b.co",
      "challenge",
    );

    expect(lastRequestHeaders().get("X-Client")).toMatch(
      /^mcp-standardnotes\/\d+\.\d+\.\d+$/,
    );
  });

  it("sends the version headers the SN api-gateway gates on (else HTTP 400)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validLoginParams));

    await getLoginParams(
      { serverUrl: "https://api.standardnotes.com" },
      "a@b.co",
      "challenge",
    );

    const headers = lastRequestHeaders();
    expect(headers.get("X-SNJS-Version")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(headers.get("X-Application-Version")).toMatch(/^\w+-\d+\.\d+\.\d+$/);
  });

  it("sends Origin/Referer when talking to the official SN host", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validLoginParams));

    await getLoginParams(
      { serverUrl: "https://api.standardnotes.com" },
      "a@b.co",
      "challenge",
    );

    const headers = lastRequestHeaders();
    expect(headers.get("Origin")).toBe("https://app.standardnotes.com");
    expect(headers.get("Referer")).toBe("https://app.standardnotes.com/");
  });

  it("omits Origin/Referer for self-hosted servers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validLoginParams));

    await getLoginParams(
      { serverUrl: "https://sync.my-sn.example.com" },
      "a@b.co",
      "challenge",
    );

    const headers = lastRequestHeaders();
    expect(headers.get("Origin")).toBeNull();
    expect(headers.get("Referer")).toBeNull();
    expect(headers.get("User-Agent")).toMatch(/Mozilla\/5\.0/);
    expect(headers.get("X-Client")).toMatch(/^mcp-standardnotes\//);
  });

  it("surfaces a body snippet when the response is not JSON (e.g. Cloudflare 403)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        "<html><head><title>Just a moment...</title></head><body>cf challenge</body></html>",
        { status: 403, headers: { "Content-Type": "text/html" } },
      ),
    );

    await expect(
      getLoginParams(
        { serverUrl: "https://example.test" },
        "a@b.co",
        "challenge",
      ),
    ).rejects.toThrow(
      /Non-JSON response from https:\/\/example\.test\/v2\/login-params \(status 403\): .*Just a moment/,
    );
  });

  it("surfaces a top-level error envelope (auth endpoints don't nest under data)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { tag: "invalid-auth", message: "Invalid email or password." } },
        { status: 400 },
      ),
    );

    const err = await getLoginParams(
      { serverUrl: "https://api.standardnotes.com" },
      "a@b.co",
      "challenge",
    ).catch((e) => e);

    expect(err).toBeInstanceOf(SnApiError);
    expect((err as SnApiError).message).toBe("Invalid email or password.");
    expect((err as SnApiError).tag).toBe("invalid-auth");
    expect((err as SnApiError).status).toBe(400);
  });

  it("preserves the mfa_key payload from a top-level mfa-required error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            tag: "mfa-required",
            message: "Please enter your two-factor code.",
            payload: { mfa_key: "mfa_1a2b3c" },
          },
        },
        { status: 401 },
      ),
    );

    const err = await getLoginParams(
      { serverUrl: "https://api.standardnotes.com" },
      "a@b.co",
      "challenge",
    ).catch((e) => e);

    expect((err as SnApiError).tag).toBe("mfa-required");
    expect((err as SnApiError).payload).toEqual({ mfa_key: "mfa_1a2b3c" });
  });

  it("attaches a redacted body snippet when a non-ok JSON response has no error message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ unexpected: "shape" }, { status: 400 }),
    );

    const err = await getLoginParams(
      { serverUrl: "https://api.standardnotes.com" },
      "a@b.co",
      "challenge",
    ).catch((e) => e);

    expect((err as SnApiError).message).toMatch(
      /^HTTP 400: .*unexpected.*shape/,
    );
  });

  it("redacts long token-like substrings inside the non-JSON snippet", async () => {
    const token = "A".repeat(40);
    fetchMock.mockResolvedValueOnce(
      new Response(`forbidden ${token} extra`, {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(
      getLoginParams(
        { serverUrl: "https://example.test" },
        "a@b.co",
        "challenge",
      ),
    ).rejects.toThrow(/\[REDACTED\]/);
  });
});
