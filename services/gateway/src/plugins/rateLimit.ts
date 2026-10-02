import rateLimit from '@fastify/rate-limit'
import fp from 'fastify-plugin'

// In-memory and per-instance for now: with 2 gateway replicas each one allows
// the full quota. Day 2 replaces this with a Redis token bucket shared by all
// replicas.
export default fp(
  async (app) => {
    await app.register(rateLimit, {
      max: 100, // 100 requests...
      timeWindow: 60_000, // ...per minute per IP
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: 'Too Many Requests',
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded, retry in ${context.after}`,
      }),
    })
  },
  { name: 'bookwise-rate-limit' },
)
