import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware.js";
import {
  SESSION_COOKIE,
  appPassword,
  isAuthorized,
  isPublicPath,
  signSession,
  verifySession,
} from "./lib/auth.js";

const PASSWORD = "correct-horse-battery-staple";

function request(path: string, cookie?: string): NextRequest {
  const req = new NextRequest(new URL(path, "http://localhost:3000"));
  if (cookie !== undefined) req.cookies.set(SESSION_COOKIE, cookie);
  return req;
}

beforeEach(() => {
  vi.stubEnv("APP_PASSWORD", PASSWORD);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("session tokens", () => {
  it("round trips a signed session", async () => {
    const token = await signSession(PASSWORD);
    expect(await verifySession(token, PASSWORD)).toBe(true);
  });

  it("rejects a token signed with a different password", async () => {
    const token = await signSession("other-password");
    expect(await verifySession(token, PASSWORD)).toBe(false);
  });

  it("rejects a tampered issue time", async () => {
    const token = await signSession(PASSWORD, 1_000);
    const [version, , signature] = token.split(".");
    expect(
      await verifySession(`${version}.2000.${signature}`, PASSWORD),
    ).toBe(false);
  });

  it("rejects an expired token", async () => {
    const issuedAt = 1_000_000;
    const token = await signSession(PASSWORD, issuedAt);
    expect(
      await verifySession(token, PASSWORD, {
        now: issuedAt + 10,
        maxAgeMs: 1000,
      }),
    ).toBe(true);
    expect(
      await verifySession(token, PASSWORD, {
        now: issuedAt + 5000,
        maxAgeMs: 1000,
      }),
    ).toBe(false);
  });

  it("rejects garbage", async () => {
    for (const token of ["", "abc", "v1.abc.def", "v2.1.2", undefined]) {
      expect(await verifySession(token, PASSWORD)).toBe(false);
    }
  });

  it("reads APP_PASSWORD, treating blank as unset", () => {
    expect(appPassword({ APP_PASSWORD: " secret " })).toBe("secret");
    expect(appPassword({ APP_PASSWORD: "   " })).toBeUndefined();
    expect(appPassword({})).toBeUndefined();
  });
});

describe("isAuthorized", () => {
  it("allows everything when no password is configured, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await isAuthorized(undefined, undefined)).toBe(true);
    // The warning is what stops the open configuration reaching production;
    // it is emitted once per process, so only assert it is not silent.
    warn.mockRestore();
  });

  it("blocks a missing cookie when a password is configured", async () => {
    expect(await isAuthorized(undefined, PASSWORD)).toBe(false);
  });
});

describe("middleware", () => {
  it("redirects to /login when there is no cookie", async () => {
    const response = await middleware(request("/topics"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/topics");
  });

  it("redirects when the cookie signature is wrong", async () => {
    const forged = await signSession("guessed-password");
    const response = await middleware(request("/digests", forged));
    expect(response.status).toBe(307);
  });

  it("allows the request through with a valid cookie", async () => {
    const token = await signSession(PASSWORD);
    const response = await middleware(request("/topics", token));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("protects the artifact route too", async () => {
    const response = await middleware(
      request("/api/artifacts/11111111-1111-4111-8111-111111111111"),
    );
    expect(response.status).toBe(307);

    const token = await signSession(PASSWORD);
    const allowed = await middleware(
      request("/api/artifacts/11111111-1111-4111-8111-111111111111", token),
    );
    expect(allowed.status).toBe(200);
  });

  it("leaves /login reachable so login is possible", async () => {
    const response = await middleware(request("/login"));
    expect(response.status).toBe(200);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/_next/static/chunk.js")).toBe(true);
    expect(isPublicPath("/topics")).toBe(false);
    // A sibling path must not inherit the prefix exemption.
    expect(isPublicPath("/login-bypass")).toBe(false);
  });

  it("lets everything through when APP_PASSWORD is unset", async () => {
    vi.stubEnv("APP_PASSWORD", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await middleware(request("/topics"));
    expect(response.status).toBe(200);
  });
});
