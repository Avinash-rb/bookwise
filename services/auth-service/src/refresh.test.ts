import { describe, expect, it } from 'vitest'
import { decideRefresh, revokesFamily, type StoredRefreshToken } from './refresh'

const now = new Date('2026-10-03T12:00:00Z')
const valid: StoredRefreshToken = {
  expires_at: new Date('2026-10-10T12:00:00Z'),
  used_at: null,
  revoked_at: null,
  is_active: true,
}

describe('refresh token decisions', () => {
  it('rotates a valid, unused token', () => {
    expect(decideRefresh(valid, now)).toBe('ROTATE')
  })

  it('detects reuse of a token that was already exchanged, and revokes the family', () => {
    const decision = decideRefresh({ ...valid, used_at: new Date('2026-10-03T11:00:00Z') }, now)
    expect(decision).toBe('REUSE_DETECTED')
    expect(revokesFamily(decision)).toBe(true)
  })

  it('rejects revoked tokens (logout) without re-revoking', () => {
    const decision = decideRefresh({ ...valid, revoked_at: new Date('2026-10-03T11:00:00Z') }, now)
    expect(decision).toBe('REVOKED')
    expect(revokesFamily(decision)).toBe(false)
  })

  it('treats a used AND revoked token as revoked (family already ended)', () => {
    const decision = decideRefresh({ ...valid, used_at: now, revoked_at: now }, now)
    expect(decision).toBe('REVOKED')
  })

  it('rejects expired tokens, including exactly at the expiry instant', () => {
    expect(decideRefresh({ ...valid, expires_at: new Date('2026-10-03T11:59:59Z') }, now)).toBe('EXPIRED')
    expect(decideRefresh({ ...valid, expires_at: now }, now)).toBe('EXPIRED')
  })

  it('ends the session of a user disabled after login', () => {
    const decision = decideRefresh({ ...valid, is_active: false }, now)
    expect(decision).toBe('USER_DISABLED')
    expect(revokesFamily(decision)).toBe(true)
  })
})
