import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import {
  AUTH_PAGES,
  isDefinitiveAuthFailure,
  isProtectedPath,
  needsSession,
} from '@/lib/auth/session-gate'

/** Do we hold anything that claims to be a session? */
function hasAuthCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith('sb-') && cookie.name.includes('auth-token'))
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (!needsSession(pathname)) {
    return NextResponse.next({ request })
  }

  // Read BEFORE the client runs: `setAll` below writes refreshed cookies
  // onto `request.cookies` too, so asking afterwards would report a
  // session that only exists because we just minted it.
  const hadAuthCookie = hasAuthCookie(request)

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  let user = null
  let authError: unknown = null
  try {
    const result = await supabase.auth.getUser()
    user = result.data.user
    authError = result.error
  } catch (error) {
    // getUser() re-throws anything that isn't an AuthError. Letting that
    // escape would 500 the page instead of showing the CRM, which is a
    // worse answer to a transient fault than simply carrying on.
    console.error('[proxy] session lookup threw:', error)
    authError = error
  }

  // We asked and got no answer. Don't act on a non-verdict — but only
  // when there was a session to verify in the first place; without an
  // auth cookie "not signed in" is a fact, not an inference.
  //
  // Letting an unverified request through is safe: every page behind
  // this is RLS-scoped, and the dashboard shell re-checks on the client
  // and pushes to /login itself. A session that really is dead still
  // ends up at the login screen — it just gets there from evidence
  // rather than from a dropped packet.
  // An error has to have actually occurred: a null user with nothing to
  // report is simply "nobody is signed in", which is a verdict.
  const unverified =
    !user &&
    Boolean(authError) &&
    hadAuthCookie &&
    !isDefinitiveAuthFailure(authError)

  const signedIn = Boolean(user)
  const signedOut = !user && !unverified

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (signedIn && AUTH_PAGES.includes(pathname)) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (inviteToken && pathname !== '/forgot-password') {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  if (signedOut && isProtectedPath(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    // Where they were headed, so signing in resumes the journey instead
    // of dumping everyone on the dashboard — and so the login page can
    // say why the form is suddenly empty again.
    url.searchParams.set('redirectedFrom', pathname)
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks). An unverified session is
  // rejected here rather than waved through: an API call has no shell to
  // re-check on the client, and 401 is a retryable answer.
  if (!signedIn && pathname.startsWith('/api/whatsapp/')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
