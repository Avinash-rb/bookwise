import fp from 'fastify-plugin'
import { Redis } from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

// One shared Redis connection for the whole gateway (rate limiting + token
// denylist). Redis is single-threaded and pipelines commands, so one connection
// handles thousands of requests per second.
export default fp<{ url: string }>(
  async (app, { url }) => {
    const redis = new Redis(url, {
      // Fail a command after 1 retry instead of queueing it forever while
      // Redis is down: a request should get a fast error, not hang.
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 1_000,
    })
    redis.on('error', (err) => app.log.warn({ err }, 'redis connection error'))

    app.decorate('redis', redis)
    app.addHook('onClose', async () => {
      await redis.quit()
    })
  },
  { name: 'bookwise-redis' },
)
