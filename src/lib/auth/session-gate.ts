// ============================================================
// The rules the middleware applies before it lets a request through.
// Pure and dependency-free so they can be tested directly — the
// middleware itself needs a NextRequest and a live Auth server.
// ============================================================

export const AUTH_PAGES = ['/login', '/signup', '/forgot-password']

/**
 * Every authenticated section.
 *
 * Sections added after this list was first written (activities, flows,
 * agents, notifications) were missing from it, so an unauthenticated
 * visit to them skipped the redirect and fell through to the app shell,
 * which then bounced to /login from the client — a flash of the empty
 * CRM first, and a pointless render of a page whose queries RLS was
 * always going to refuse. Anything mounted under `(dashboard)` belongs
 * here.
 */
export const PROTECTED_PREFIXES = [
  '/dashboard',
  '/inbox',
  '/contacts',
  '/activities',
  '/pipelines',
  '/automations',
  '/flows',
  '/agents',
  '/notifications',
  '/settings',
]

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((path) => pathname.startsWith(path))
}

/**
 * Does this request need the session resolved at all?
 *
 * Everything else — the marketing root, `/join/<token>`, the provider
 * webhooks, the API-key-authenticated `/api/v1/*` — is either public or
 * authenticated by other means, and asking Supabase "who is this?" for
 * those requests bought nothing.
 *
 * It cost plenty, though: `getUser()` is a network round-trip to the
 * Auth server on EVERY matched request, including RSC payloads and
 * prefetches. Those calls count against the project's auth rate limit,
 * and a 429 or a 5xx there used to read as "logged out" (see
 * `isDefinitiveAuthFailure`) — so the surplus calls were actively
 * manufacturing the sign-in failures this gate exists to prevent.
 * Narrowing the check keeps the token refresh running on every real
 * page view, since those all live under a protected prefix.
 */
export function needsSession(pathname: string): boolean {
  if (AUTH_PAGES.includes(pathname)) return true
  if (isProtectedPath(pathname)) return true
  return pathname.startsWith('/api/whatsapp/') && !pathname.includes('/webhook')
}

/**
 * Is this error the Auth server actually saying "this session is not
 * valid", as opposed to us failing to ask it?
 *
 * The distinction is the whole point. `getUser()` reports both cases
 * identically — `user: null` plus an error — and treating them alike
 * meant a network blip, a 429 from the auth rate limiter, or a Supabase
 * 5xx signed the user out: correct credentials, a landing on
 * /dashboard, an immediate bounce back, and a blank form with no
 * explanation.
 *
 * A rejected token comes back as an AuthApiError with a 4xx status, and
 * a locally-raised AuthSessionMissingError means there was no token to
 * check. Everything else — status 0 (fetch failed, per auth-js's
 * AuthRetryableFetchError), 429, 5xx, anything unrecognised — means we
 * reached no verdict.
 */
export function isDefinitiveAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { name, status } = error as { name?: string; status?: number }
  if (name === 'AuthSessionMissingError') return true
  if (typeof status !== 'number') return false
  // 429 is the auth rate limiter, not a rejection of these credentials.
  return status >= 400 && status < 500 && status !== 429
}

/**
 * Where to land after signing in, given the path the middleware
 * bounced the user away from.
 *
 * Only same-origin paths are honoured. `//evil.com` is a valid
 * *relative* URL as far as the browser is concerned and would navigate
 * off-site, so a second leading slash disqualifies the value — this
 * comes from a query parameter, which is attacker-supplied by
 * definition.
 */
export function safeDestination(redirectedFrom: string | null | undefined): string | null {
  if (!redirectedFrom) return null
  if (!redirectedFrom.startsWith('/')) return null
  if (redirectedFrom.startsWith('//')) return null
  // A backslash is normalised to a forward slash by some browsers, so
  // `/\evil.com` is the same trick wearing a different hat.
  if (redirectedFrom.startsWith('/\\')) return null
  return redirectedFrom
}
