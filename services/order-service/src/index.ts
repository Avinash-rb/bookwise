import Fastify from 'fastify'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

import orderRoutes from './routes/orders'

const app = Fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } }
  }
})

const start = async () => {
  try {
    await app.register(orderRoutes, { prefix: '/orders' })

    app.get('/health', async () => ({
      status: 'ok',
      service: 'order-service',
      timestamp: new Date().toISOString()
    }))

    await app.listen({ port: 3001, host: '0.0.0.0' })
    console.log('📦 Order service running on http://localhost:3001')
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
