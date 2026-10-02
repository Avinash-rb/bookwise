import Fastify from 'fastify'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

import paymentRoutes from './routes/payments'

const app = Fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } }
  }
})

const start = async () => {
  try {
    await app.register(paymentRoutes, { prefix: '/payments' })

    app.get('/health', async () => ({
      status: 'ok',
      service: 'payment-service',
      timestamp: new Date().toISOString()
    }))

    await app.listen({ port: 3003, host: '0.0.0.0' })
    console.log('💳 Payment service running on http://localhost:3003')
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
