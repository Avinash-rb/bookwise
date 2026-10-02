import Fastify from 'fastify'
import config from './config'

// Import plugins
import jwtPlugin from './plugins/jwt'
import rateLimitPlugin from './plugins/rateLimit'

// Import routes
import healthRoutes from './routes/health'
import authRoutes from './routes/auth'
import proxyRoutes from './routes/proxy'

// ── Bootstrap ──────────────────────────────────────────────
const app = Fastify({
  logger: {
    level: config.nodeEnv === 'development' ? 'info' : 'warn',
    transport: config.nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined
  }
})

const start = async () => {
  try {
    // Register plugins (order matters — rate limit before JWT)
    await app.register(rateLimitPlugin)
    await app.register(jwtPlugin)

    // Register routes
    await app.register(healthRoutes)
    await app.register(authRoutes)
    await app.register(proxyRoutes)

    // Start server
    await app.listen({ port: config.port, host: '0.0.0.0' })
    console.log(`🚀 Gateway running on http://localhost:${config.port}`)

  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
