import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
// `mockAuthError`    — what getUser() reports alongside a null user. Real
//                      auth-js never returns a null user with no error;
//                      WHICH error decides whether we're looking at a
//                      signed-out visitor or at a failure to ask.
let mockUser: { id: string } | null = null;
let mockAuthError: { name: string; status?: number } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser }, error: mockAuthError };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { proxy } = await import("./proxy");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  mockAuthError = null;
  refreshedCookies = [];
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("proxy — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await proxy(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await proxy(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await proxy(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await proxy(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

/** A request that arrives holding a session cookie, as a real one does. */
function withSession(url: string): NextRequest {
  const request = new NextRequest(url);
  request.cookies.set("sb-test-auth-token", "some-session");
  return request;
}

describe("proxy — a failure to verify is not a sign-out", () => {
  it("lets the request through when the Auth server could not be reached", async () => {
    mockUser = null;
    // auth-js reports a failed fetch this way (status 0).
    mockAuthError = { name: "AuthRetryableFetchError", status: 0 };

    const res = await proxy(withSession("https://app.test/dashboard"));

    // The reported bug: a blip here bounced the user to /login moments
    // after they signed in with the right credentials.
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets the request through when the auth rate limiter answers 429", async () => {
    mockUser = null;
    mockAuthError = { name: "AuthApiError", status: 429 };

    const res = await proxy(withSession("https://app.test/inbox"));

    expect(res.headers.get("location")).toBeNull();
  });

  it("still redirects when the token is genuinely rejected", async () => {
    mockUser = null;
    mockAuthError = { name: "AuthApiError", status: 401 };

    const res = await proxy(withSession("https://app.test/inbox"));

    expect(res.headers.get("location")).toContain("/login");
  });

  it("still redirects when there is no session cookie at all", async () => {
    mockUser = null;
    mockAuthError = { name: "AuthRetryableFetchError", status: 0 };

    // Nothing to verify — "not signed in" is a fact here, not a guess.
    const res = await proxy(new NextRequest("https://app.test/inbox"));

    expect(res.headers.get("location")).toContain("/login");
  });

  it("tells the login page where the user was headed", async () => {
    mockUser = null;
    mockAuthError = { name: "AuthSessionMissingError", status: 400 };

    const res = await proxy(new NextRequest("https://app.test/inbox"));

    expect(res.headers.get("location")).toContain("redirectedFrom=%2Finbox");
  });
});

describe("proxy — authenticated pages are never shared-cacheable", () => {
  // The bug this guards: /dashboard is a STATIC route, so the public
  // caching policy applied to it. One URL answers a browser with HTML
  // and the App Router with the RSC flight payload, told apart only by
  // a request header — a CDN that ignores Vary caches whichever came
  // first. When the payload won, visitors got a page of raw
  // `0:{"tree":…}` text and nothing threw for an error boundary.
  const NO_STORE = /no-store/;

  it("marks a signed-in page load private and unstored", async () => {
    mockUser = { id: "user-1" };
    const res = await proxy(new NextRequest("https://app.test/dashboard"));
    expect(res.headers.get("cache-control")).toMatch(NO_STORE);
    expect(res.headers.get("cache-control")).toMatch(/private/);
  });

  it("marks the redirect away from a protected page too", async () => {
    mockUser = null;
    const res = await proxy(new NextRequest("https://app.test/inbox"));
    expect(res.headers.get("location")).toContain("/login");
    // A cached redirect is its own outage: it would pin every visitor
    // to /login until the entry expired.
    expect(res.headers.get("cache-control")).toMatch(NO_STORE);
  });

  it("marks the login page, which redirects once signed in", async () => {
    mockUser = { id: "user-1" };
    const res = await proxy(new NextRequest("https://app.test/login"));
    expect(res.headers.get("cache-control")).toMatch(NO_STORE);
  });
});

describe("proxy — routes that don't need a session", () => {
  it("does not touch the provider webhooks", async () => {
    // A 401 here would silently drop inbound WhatsApp messages.
    mockUser = null;
    const res = await proxy(
      new NextRequest("https://app.test/api/whatsapp/uazapi/webhook/c1/s1"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not touch the API-key authenticated public API", async () => {
    mockUser = null;
    const res = await proxy(new NextRequest("https://app.test/api/v1/messages"));
    expect(res.status).toBe(200);
  });

  it("still guards the session-authenticated WhatsApp routes", async () => {
    mockUser = null;
    const res = await proxy(new NextRequest("https://app.test/api/whatsapp/send"));
    expect(res.status).toBe(401);
  });
});
