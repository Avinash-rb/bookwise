import { AppError } from '@bookwise/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

// Token bucket: each client has a bucket of `capacity` tokens that refills at
// a steady rate. A request spends one token; an empty bucket means 429.
// Allows short bursts (up to capacity) while capping the long-run average.
export interface RateLimitPolicy {
  name: string
  capacity: number
  refillPerSecond: number
}

export const POLICIES = {
  // Every request, per IP. Generous: browsing a seat map takes several calls.
  global: { name: 'global', capacity: 100, refillPerSecond: 100 / 60 },
  // Login / register / refresh, per IP (one shared bucket): slows down
  // password guessing to 10 tries a minute.
  auth: { name: 'auth', capacity: 10, refillPerSecond: 10 / 60 },
  // Placing orders, per user: stops one account from hoarding seats.
  booking: { name: 'booking', capacity: 5, refillPerSecond: 5 / 60 },
} satisfies Record<string, RateLimitPolicy>

// Runs inside Redis, atomically: no other command can run between reading and
// writing the bucket, so two gateway replicas can't both spend the last token.
// Doing this as GET + SET from Node would be a race.
// Returns { allowed (1/0), tokens left, seconds until a token is available }.
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])

-- Redis' own clock: every gateway replica sees the same time.
local t = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now

-- Add the tokens earned since the last request, up to capacity.
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
-- After capacity/rate seconds idle the bucket is full again, i.e. the same as
-- no bucket at all, so Redis may delete it.
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / rate))

local retry_after = 0
if allowed == 0 then
  retry_after = math.ceil((1 - tokens) / rate)
end
return { allowed, math.floor(tokens), retry_after }
`

type TakeToken = (key: string, capacity: number, refillPerSecond: number) => Promise<[number, number, number]>
type KeyFn = (request: FastifyRequest) => string

declare module 'fastify' {
  interface FastifyInstance {
    rateLimit: (
      policy: RateLimitPolicy,
      keyBy: KeyFn,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export const byIp: KeyFn = (request) => request.ip
export const byUser: KeyFn = (request) => request.user?.id ?? request.ip

export default fp(
  async (app) => {
    // defineCommand loads the script once (SCRIPT LOAD) and then calls it by
    // its SHA1 hash (EVALSHA), so the script body isn't resent every time.
    app.redis.defineCommand('takeToken', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA })
    const redis = app.redis as unknown as { takeToken: TakeToken }

    app.decorate('rateLimit', (policy: RateLimitPolicy, keyBy: KeyFn) => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        let result: [number, number, number]
        try {
          result = await redis.takeToken(
            `ratelimit:${policy.name}:${keyBy(request)}`,
            policy.capacity,
            policy.refillPerSecond,
          )
        } catch (err) {
          // Fail OPEN: a broken rate limiter shouldn't take the whole API down.
          // (Compare the token denylist, which fails closed.)
          request.log.warn({ err, policy: policy.name }, 'rate limiter unavailable, allowing request')
          return
        }

        const [allowed, remaining, retryAfter] = result
        reply.header('ratelimit-limit', policy.capacity)
        reply.header('ratelimit-remaining', remaining)
        if (allowed === 1) return

        reply.header('retry-after', retryAfter)
        throw new AppError(429, 'RATE_LIMITED', `Too many requests, retry in ${retryAfter}s`)
      }
    })

    // Global per-IP limit on every request except health probes (Docker
    // polls those every few seconds).
    const global = app.rateLimit(POLICIES.global, byIp)
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/health/')) await global(request, reply)
    })
  },
  { name: 'bookwise-rate-limit', dependencies: ['bookwise-redis'] },
)
