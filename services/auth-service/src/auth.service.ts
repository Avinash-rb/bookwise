import { randomUUID } from 'node:crypto'
import {
  conflict,
  forbidden,
  type Logger,
  notFound,
  type Pool,
  type PoolClient,
  unauthorized,
  withTransaction,
} from '@bookwise/common'
import { hashPassword, verifyPassword } from './password'
import { decideRefresh, revokesFamily } from './refresh'
import { generateRefreshToken, hashRefreshToken, type Role, type TokenIssuer } from './tokens'

export interface AuthServiceDeps {
  pool: Pool
  logger: Logger
  tokens: TokenIssuer
  accessTtlSeconds: number
  refreshTtlDays: number
}

interface UserRow {
  id: string
  email: string
  full_name: string
  role: Role
  is_active: boolean
}

export interface RegisterInput {
  email: string
  password: string
  full_name: string
  role?: 'customer' | 'vendor'
}

const normaliseEmail = (email: string) => email.trim().toLowerCase()

const publicUser = (user: UserRow) => ({
  id: user.id,
  email: user.email,
  full_name: user.full_name,
  role: user.role,
})

const INVALID_CREDENTIALS = 'Invalid email or password'

export function createAuthService({
  pool,
  logger,
  tokens,
  accessTtlSeconds,
  refreshTtlDays,
}: AuthServiceDeps) {
  // Hash of a random password, used when the email doesn't exist so that login
  // takes the same time either way (otherwise response timing reveals which
  // emails have accounts).
  const dummyHash = hashPassword(randomUUID())

  // A "session" = a fresh access token + a refresh token stored (hashed) in
  // the DB. A new login starts a new family; a rotation continues the old one.
  async function issueSession(db: Pool | PoolClient, user: UserRow, familyId: string = randomUUID()) {
    const refreshToken = generateRefreshToken()
    await db.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [user.id, familyId, hashRefreshToken(refreshToken), refreshTtlDays],
    )
    return {
      user: publicUser(user),
      access_token: tokens.issueAccessToken({ sub: user.id, role: user.role, email: user.email }),
      token_type: 'Bearer' as const,
      expires_in: accessTtlSeconds,
      refresh_token: refreshToken,
    }
  }

  async function register({ email, password, full_name, role = 'customer' }: RegisterInput) {
    // Hash BEFORE opening the transaction: ~100 ms of CPU work shouldn't hold a
    // pooled DB connection.
    const passwordHash = await hashPassword(password)

    return withTransaction(pool, async (client) => {
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING
         RETURNING id, email, full_name, role, is_active`,
        [normaliseEmail(email), passwordHash, full_name.trim(), role],
      )
      const user = rows[0]
      if (!user) throw conflict('An account with this email already exists')
      return issueSession(client, user)
    })
  }

  async function login(email: string, password: string) {
    const { rows } = await pool.query<UserRow & { password_hash: string }>(
      'SELECT id, email, full_name, role, is_active, password_hash FROM users WHERE email = $1',
      [normaliseEmail(email)],
    )
    const user = rows[0]

    // Always run exactly one password hash, whether or not the user exists.
    const valid = await verifyPassword(password, user?.password_hash ?? (await dummyHash))

    // Same message for "no such email" and "wrong password" (no user enumeration).
    if (!user || !valid) throw unauthorized(INVALID_CREDENTIALS)
    if (!user.is_active) throw forbidden('This account has been disabled')

    return issueSession(pool, user)
  }

  async function refresh(refreshToken: string) {
    const outcome = await withTransaction(pool, async (client) => {
      // FOR UPDATE locks the token row: if the same token is presented twice at
      // the same moment, the second request waits, then sees it already used.
      const { rows } = await client.query<
        UserRow & {
          token_id: string
          family_id: string
          expires_at: Date
          used_at: Date | null
          revoked_at: Date | null
        }
      >(
        `SELECT rt.id AS token_id, rt.family_id, rt.expires_at, rt.used_at, rt.revoked_at,
                u.id, u.email, u.full_name, u.role, u.is_active
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1
         FOR UPDATE OF rt`,
        [hashRefreshToken(refreshToken)],
      )
      const row = rows[0]
      if (!row) return { decision: 'UNKNOWN' as const }

      const decision = decideRefresh(row, new Date())

      if (decision === 'ROTATE') {
        await client.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [row.token_id])
        return { decision, session: await issueSession(client, row, row.family_id) }
      }

      if (revokesFamily(decision)) {
        await client.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
          [row.family_id],
        )
      }
      return { decision, userId: row.id, familyId: row.family_id }
    })

    // Throw only AFTER the transaction has committed. Throwing inside
    // withTransaction would roll back the family revocation above.
    if (outcome.decision === 'ROTATE') return outcome.session

    if (outcome.decision === 'REUSE_DETECTED') {
      logger.warn(
        { userId: outcome.userId, familyId: outcome.familyId },
        'refresh token reuse detected: session family revoked',
      )
    }
    throw unauthorized('Invalid or expired refresh token')
  }

  // Ends the whole session (every token in the family). Always succeeds, even
  // for unknown tokens: logout should be idempotent and reveal nothing.
  async function logout(refreshToken: string) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE revoked_at IS NULL
         AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [hashRefreshToken(refreshToken)],
    )
  }

  async function getUser(userId: string) {
    const { rows } = await pool.query<UserRow>(
      'SELECT id, email, full_name, role, is_active FROM users WHERE id = $1',
      [userId],
    )
    const user = rows[0]
    if (!user?.is_active) throw notFound('User not found')
    return publicUser(user)
  }

  // Creates the admin account from environment variables if it doesn't exist.
  // Admin is never available through public registration.
  async function seedAdmin(email: string, password: string) {
    const normalised = normaliseEmail(email)
    const existing = await pool.query<{ role: Role }>('SELECT role FROM users WHERE email = $1', [normalised])
    const current = existing.rows[0]
    if (current) {
      if (current.role !== 'admin')
        logger.warn({ email: normalised }, 'ADMIN_EMAIL belongs to a non-admin user')
      return
    }
    await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, 'Administrator', 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [normalised, await hashPassword(password)],
    )
    logger.info({ email: normalised }, 'admin account created')
  }

  return { register, login, refresh, logout, getUser, seedAdmin }
}

export type AuthService = ReturnType<typeof createAuthService>
