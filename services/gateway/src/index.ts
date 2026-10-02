import { createApp, createLogger, healthPlugin, startServer } from '@bookwise/common'
import config from './config'
import jwtPlugin from './plugins/jwt'
import rateLimitPlugin from './plugins/rateLimit'
import authRoutes from './routes/auth'
import proxyRoutes from './routes/proxy'

async function main() {
  const logger = createLogger({
    service: 'gateway',
    level: config.logLevel,
    pretty: config.nodeEnv === 'development',
  })
  const app = createApp(logger)

  // Order matters: rate limiting runs before JWT verification so a flood of
  // requests with garbage tokens is rejected cheaply.
  await app.register(rateLimitPlugin)
  await app.register(jwtPlugin)

  await app.register(healthPlugin)
  await app.register(authRoutes)
  await app.register(proxyRoutes)

  await startServer(app, { port: config.port, logger })
}

main().catch((err: unknown) => {
  console.error('gateway failed to start', err)
  process.exit(1)
})
