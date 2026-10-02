import path from 'node:path'
import {
  createApp,
  createLogger,
  createPool,
  healthPlugin,
  runMigrations,
  startServer,
} from '@bookwise/common'
import { config } from './config'
import paymentRoutes from './routes/payments'

async function main() {
  const logger = createLogger({
    service: 'payment-service',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  })
  const pool = createPool(config.PAYMENT_DB_URL, logger, { application_name: 'payment-service' })

  if (config.RUN_MIGRATIONS) {
    await runMigrations(pool, path.join(__dirname, '..', 'migrations'), logger)
  }

  const app = createApp(logger)
  app.addHook('onClose', () => pool.end())

  await app.register(healthPlugin, { checks: { postgres: () => pool.query('SELECT 1') } })
  await app.register(paymentRoutes, { prefix: '/payments', pool })

  await startServer(app, { port: config.PAYMENT_SERVICE_PORT, logger })
}

main().catch((err: unknown) => {
  console.error('payment-service failed to start', err)
  process.exit(1)
})
