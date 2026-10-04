import { forbidden, serviceUnavailable, unauthorized } from '@bookwise/common'
import { createVerifier } from 'fast-jwt'
import type { FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

export type Role = 'customer' | 'vendor' | 'admin'
const ROLES: readonly string[] = ['customer', 'vendor', 'admin']

// The caller's identity, taken from a verified access token.
export interface AuthUser {
  id: string
  role: Role
  email: string
  jti: string // token id, used to revoke this one token
  exp: number // expiry, seconds since epoch
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>
    optionalAuthenticate: (request: FastifyRequest) => Promise<void>
    requireRole: (...roles: Role[]) => (request: FastifyRequest) => Promise<void>
    revokeAccessToken: (user: AuthUser) => Promise<void>
  }
  interface FastifyRequest {
    user: AuthUser | null
  }
}

export interface AuthOptions {
  publicKeyPem: string
  issuer: string
  audience: string
}

// Verifies signature (RS256 with the PUBLIC key), expiry, issuer and audience,
// then checks the claims have the shape we expect.
export function createAccessTokenVerifier({ publicKeyPem, issuer, audience }: AuthOptions) {
  const verify = createVerifier({
    key: publicKeyPem,
    // Pin the algorithm. Never trust the token's own "alg" header: an attacker
    // could send alg=HS256 and sign with our (public!) key as an HMAC secret.
    algorithms: ['RS256'],
    allowedIss: issuer,
    allowedAud: audience,
    requiredClaims: ['sub', 'jti', 'exp'],
  })

  return (token: string): AuthUser => {
    const claims = verify(token)
    if (typeof claims.email !== 'string' || !ROLES.includes(claims.role)) {
      throw new Error('access token has malformed claims')
    }
    return { id: claims.sub, role: claims.role, email: claims.email, jti: claims.jti, exp: claims.exp }
  }
}

// "Authorization: Bearer <token>" -> "<token>"
export function bearerToken(header: string | undefined): string | null {
  const [scheme, token, ...rest] = (header ?? '').split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null
  return token
}

export const denylistKey = (jti: string) => `denylist:jti:${jti}`

export default fp<AuthOptions>(
  async (app, options) => {
    const verifyToken = createAccessTokenVerifier(options)

    app.decorateRequest('user', null)

    // Trust boundary. Services believe the x-user-* headers because only the
    // gateway can reach them, so a client must never be able to send its own.
    // (The proxy also builds upstream headers from a whitelist; this is the
    // second layer.)
    app.addHook('onRequest', async (request) => {
      for (const name of Object.keys(request.headers)) {
        if (name.startsWith('x-user-')) delete request.headers[name]
      }
    })

    async function isRevoked(request: FastifyRequest, jti: string): Promise<boolean> {
      try {
        return (await app.redis.exists(denylistKey(jti))) === 1
      } catch (err) {
        // Fail CLOSED: if we can't tell whether a token was logged out, we
        // don't accept it. A logged-out token must never work.
        request.log.error({ err }, 'token denylist check failed')
        throw serviceUnavailable('Authentication is temporarily unavailable')
      }
    }

    // Resolves the caller from the token, or null if there is no valid one.
    async function identify(request: FastifyRequest): Promise<AuthUser | null> {
      const token = bearerToken(request.headers.authorization)
      if (!token) return null
      let user: AuthUser
      try {
        user = verifyToken(token)
      } catch {
        return null
      }
      return (await isRevoked(request, user.jti)) ? null : user
    }

    app.decorate('authenticate', async (request: FastifyRequest) => {
      request.user = await identify(request)
      // One message for missing, invalid, expired and revoked tokens.
      if (!request.user) throw unauthorized('Invalid or missing access token')
    })

    // For routes that work with or without a login (logout).
    app.decorate('optionalAuthenticate', async (request: FastifyRequest) => {
      request.user = await identify(request)
    })

    // Role check (RBAC). Runs after authenticate. 401 = "who are you?",
    // 403 = "I know who you are, and you can't do this".
    app.decorate('requireRole', (...roles: Role[]) => async (request: FastifyRequest) => {
      if (!request.user) throw unauthorized()
      if (!roles.includes(request.user.role)) throw forbidden()
    })

    // Logout: put the token's jti on the denylist until the token would have
    // expired anyway. After that the token is dead by itself, so Redis drops
    // the key: the denylist never grows beyond 15 minutes' worth of logouts.
    app.decorate('revokeAccessToken', async (user: AuthUser) => {
      const secondsLeft = user.exp - Math.floor(Date.now() / 1000)
      if (secondsLeft > 0) await app.redis.set(denylistKey(user.jti), '1', 'EX', secondsLeft)
    })
  },
  { name: 'bookwise-auth', dependencies: ['bookwise-redis'] },
)
