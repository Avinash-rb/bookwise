import { createApp, createLogger, healthPlugin, startServer } from '@bookwise/common'
import config from './config'
import authPlugin from './plugins/auth'
import rateLimitPlugin from './plugins/rateLimit'
import redisPlugin from './plugins/redis'
import { createForwarder } from './proxy'
import apiRoutes from './routes/api'

async function main() {
  const logger = createLogger({
    service: 'gateway',
    level: config.logLevel,
    pretty: config.nodeEnv === 'development',
  })
  const app = createApp(logger)

  await app.register(redisPlugin, { url: config.redisUrl })
  // Rate limiting registers its global hook first, so a flood of requests is
  // rejected before any token verification work is done.
  await app.register(rateLimitPlugin)
  await app.register(authPlugin, config.jwt)

  // The gateway is "ready" when Redis is reachable: without it, it can neither
  // check revoked tokens nor rate-limit. Upstream services are deliberately
  // NOT checked: one service being down shouldn't take the whole gateway out
  // of the load balancer (it answers 503 for that service's routes instead).
  await app.register(healthPlugin, { checks: { redis: () => app.redis.ping() } })
  await app.register(apiRoutes, {
    forward: createForwarder({ services: config.services, timeoutMs: config.upstreamTimeoutMs }),
  })

  await startServer(app, { port: config.port, logger })
}

main().catch((err: unknown) => {
  console.error('gateway failed to start', err)
  process.exit(1)
})
