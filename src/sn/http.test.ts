import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return { ...actual, fetch: fetchMock };
});

import { getLoginParams } from "./http.js";

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
