import { describe, expect, it } from 'vitest'

import {
  isDefinitiveAuthFailure,
  isProtectedPath,
  needsSession,
  safeDestination,
} from './session-gate'

describe('needsSession', () => {
  it('covers the auth pages and every dashboard section', () => {
    for (const path of ['/login', '/signup', '/forgot-password']) {
      expect(needsSession(path)).toBe(true)
    }
    for (const path of ['/dashboard', '/inbox', '/activities', '/settings/whatsapp']) {
      expect(needsSession(path)).toBe(true)
    }
  })

  it('covers the session-authenticated WhatsApp routes but not the webhooks', () => {
    expect(needsSession('/api/whatsapp/send')).toBe(true)
    expect(
      needsSession('/api/whatsapp/uazapi/webhook/conn-1/secret-1')
    ).toBe(false)
  })

  it('skips routes authenticated by other means, or not at all', () => {
    // Every one of these used to cost a round-trip to the Auth server.
    expect(needsSession('/')).toBe(false)
    expect(needsSession('/join/abc123')).toBe(false)
    expect(needsSession('/api/v1/messages')).toBe(false)
  })
})

describe('isProtectedPath', () => {
  it('matches nested routes, not just section roots', () => {
    expect(isProtectedPath('/flows/123/runs')).toBe(true)
    expect(isProtectedPath('/login')).toBe(false)
  })
})

describe('isDefinitiveAuthFailure', () => {
  it('treats a rejected token as a real sign-out', () => {
    expect(isDefinitiveAuthFailure({ name: 'AuthApiError', status: 401 })).toBe(true)
    expect(isDefinitiveAuthFailure({ name: 'AuthApiError', status: 403 })).toBe(true)
    expect(isDefinitiveAuthFailure({ name: 'AuthSessionMissingError', status: 400 })).toBe(
      true
    )
  })

  it('does NOT sign the user out over a fault we caused or hit', () => {
    // auth-js reports a failed fetch as AuthRetryableFetchError/status 0.
    expect(isDefinitiveAuthFailure({ name: 'AuthRetryableFetchError', status: 0 })).toBe(
      false
    )
    // Supabase 5xx — also retryable.
    expect(isDefinitiveAuthFailure({ name: 'AuthRetryableFetchError', status: 503 })).toBe(
      false
    )
    // The auth rate limiter says "too many", not "wrong credentials".
    expect(isDefinitiveAuthFailure({ name: 'AuthApiError', status: 429 })).toBe(false)
    expect(isDefinitiveAuthFailure(new Error('boom'))).toBe(false)
    expect(isDefinitiveAuthFailure(null)).toBe(false)
    expect(isDefinitiveAuthFailure(undefined)).toBe(false)
  })
})

describe('safeDestination', () => {
  it('keeps an internal path', () => {
    expect(safeDestination('/inbox')).toBe('/inbox')
    expect(safeDestination('/flows/1/runs')).toBe('/flows/1/runs')
  })

  it('refuses anything that could leave the site', () => {
    expect(safeDestination('//evil.com')).toBeNull()
    expect(safeDestination('/\\evil.com')).toBeNull()
    expect(safeDestination('https://evil.com')).toBeNull()
    expect(safeDestination('evil.com')).toBeNull()
    expect(safeDestination(null)).toBeNull()
    expect(safeDestination('')).toBeNull()
  })
})
