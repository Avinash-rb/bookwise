import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import fp from 'fastify-plugin'

export interface SecurityOptions {
  // Browser origins allowed to call the API, e.g. the React app.
  corsOrigins: string[]
}

// Browser-facing protections. They only matter for browsers (curl and other
// services ignore them), and the gateway is the one place browsers talk to.
export default fp<SecurityOptions>(
  async (app, { corsOrigins }) => {
    // helmet: security response headers. This API only ever returns JSON, so
    // the Content-Security-Policy can forbid everything: if a response were
    // ever rendered as a page, it couldn't load scripts or be framed
    // (clickjacking). Also sets nosniff, HSTS, Referrer-Policy and more.
    await app.register(helmet, {
      contentSecurityPolicy: {
        // Without this, helmet merges in its website defaults (script-src
        // 'self', img-src 'self', ...), which loosen the policy.
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
    })

    // CORS: browsers block JavaScript on another origin (our React app on
    // :5173) from reading API responses unless the API allows that origin.
    // An explicit allowlist, never "*". CORS protects users' browsers; it is
    // NOT authentication (curl ignores it entirely).
    await app.register(cors, {
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
      // Response headers the frontend's JavaScript may read.
      exposedHeaders: ['x-request-id', 'ratelimit-limit', 'ratelimit-remaining', 'retry-after'],
      // Tokens travel in the Authorization header, not cookies, so no
      // credentials mode. (Changes if the refresh token moves to a cookie.)
      credentials: false,
      maxAge: 600, // browsers may cache the preflight answer for 10 minutes
    })
  },
  { name: 'bookwise-security' },
)
