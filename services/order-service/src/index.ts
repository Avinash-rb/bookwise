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
import orderRoutes from './routes/orders'
import { createSaga } from './services/saga'

async function main() {
  const logger = createLogger({
    service: 'order-service',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  })
  const pool = createPool(config.ORDER_DB_URL, logger, { application_name: 'order-service' })

  if (config.RUN_MIGRATIONS) {
    await runMigrations(pool, path.join(__dirname, '..', 'migrations'), logger)
  }

  const saga = createSaga({
    pool,
    logger,
    inventoryUrl: config.INVENTORY_SERVICE_URL,
    paymentUrl: config.PAYMENT_SERVICE_URL,
  })

  const app = createApp(logger)
  app.addHook('onClose', () => pool.end())

  await app.register(healthPlugin, { checks: { postgres: () => pool.query('SELECT 1') } })
  await app.register(orderRoutes, { prefix: '/orders', pool, saga })

  await startServer(app, { port: config.ORDER_SERVICE_PORT, logger })
}

main().catch((err: unknown) => {
  console.error('order-service failed to start', err)
  process.exit(1)
})
