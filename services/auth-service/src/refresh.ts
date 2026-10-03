// Decides what to do with a presented refresh token. Kept as a pure function
// (no DB, no clock of its own) so every case is easy to unit-test.

export interface StoredRefreshToken {
  expires_at: Date
  used_at: Date | null
  revoked_at: Date | null
  is_active: boolean // the owning user's account status
}

export type RefreshDecision =
  | 'ROTATE' // valid: mark used, issue a successor in the same family
  | 'REUSE_DETECTED' // already exchanged once: someone holds a copy -> revoke the family
  | 'REVOKED' // logged out, or the family was already revoked
  | 'EXPIRED'
  | 'USER_DISABLED' // account disabled since login -> revoke the family

export function decideRefresh(token: StoredRefreshToken, now: Date): RefreshDecision {
  if (token.revoked_at) return 'REVOKED'
  // A legitimate client never presents a token twice: it always switches to the
  // new one it received. Reuse means two parties have it (user + thief), and we
  // can't tell which is which, so the whole session family is ended.
  if (token.used_at) return 'REUSE_DETECTED'
  if (token.expires_at <= now) return 'EXPIRED'
  if (!token.is_active) return 'USER_DISABLED'
  return 'ROTATE'
}

// Decisions that must revoke every token in the family.
export const revokesFamily = (decision: RefreshDecision) =>
  decision === 'REUSE_DETECTED' || decision === 'USER_DISABLED'
