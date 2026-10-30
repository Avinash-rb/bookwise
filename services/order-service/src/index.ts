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
import adminRoutes from './routes/admin'
import orderRoutes from './routes/orders'
import { createStepRunner } from './saga/steps'
import { createSagaWorker } from './saga/worker'

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

  const worker = createSagaWorker({
    pool,
    logger: logger.child({ component: 'saga-worker' }),
    runStep: createStepRunner({
      inventoryUrl: config.INVENTORY_SERVICE_URL,
      paymentUrl: config.PAYMENT_SERVICE_URL,
      internalToken: config.INTERNAL_SERVICE_TOKEN,
      timeoutMs: config.SAGA_STEP_TIMEOUT_MS,
      logger: logger.child({ component: 'saga-steps' }),
    }),
    options: {
      pollIntervalMs: config.SAGA_POLL_INTERVAL_MS,
      concurrency: config.SAGA_CONCURRENCY,
      leaseSeconds: config.SAGA_LEASE_SECONDS,
      maxAttempts: config.SAGA_MAX_ATTEMPTS,
    },
  })

  const app = createApp(logger)
  // Stop the worker (letting in-flight steps finish and save) before closing
  // the pool it uses.
  app.addHook('onClose', async () => {
    await worker.stop()
    await pool.end()
  })

  await app.register(healthPlugin, { checks: { postgres: () => pool.query('SELECT 1') } })
  await app.register(orderRoutes, { prefix: '/orders', pool, worker })
  await app.register(adminRoutes, { prefix: '/admin', pool, worker })

  // Also picks up sagas left unfinished by a previous crash (their leases
  // have expired), so bookings resume after a restart.
  worker.start()
  await startServer(app, { port: config.ORDER_SERVICE_PORT, logger })
}

main().catch((err: unknown) => {
  console.error('order-service failed to start', err)
  process.exit(1)
})
