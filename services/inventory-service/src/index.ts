import Fastify from 'fastify'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

import movieRoutes from './routes/movies'
import theatreRoutes from './routes/theatres'
import showRoutes from './routes/shows'

const app = Fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } }
  }
})

const start = async () => {
  try {
    await app.register(movieRoutes, { prefix: '/movies' })
    await app.register(theatreRoutes, { prefix: '/theatres' })
    await app.register(showRoutes, { prefix: '/shows' })

    // Health check
    app.get('/health', async () => ({
      status: 'ok',
      service: 'inventory-service',
      timestamp: new Date().toISOString()
    }))

    await app.listen({ port: 3002, host: '0.0.0.0' })
    console.log('🎬 Inventory service running on http://localhost:3002')
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
