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
import { createReservations } from './reservations'
import adminRoutes from './routes/admin'
import internalRoutes from './routes/internal'
import movieRoutes from './routes/movies'
import showRoutes from './routes/shows'
import theatreRoutes from './routes/theatres'
import vendorRoutes from './routes/vendor'
import { startSweeper } from './sweeper'

async function main() {
  const logger = createLogger({
    service: 'inventory-service',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  })
  const pool = createPool(config.INVENTORY_DB_URL, logger, { application_name: 'inventory-service' })

  if (config.RUN_MIGRATIONS) {
    await runMigrations(pool, path.join(__dirname, '..', 'migrations'), logger)
  }

  const reservations = createReservations({ pool, ttlSeconds: config.RESERVATION_TTL_SECONDS })
  const sweeper = startSweeper({ reservations, logger, intervalMs: config.SWEEP_INTERVAL_MS })

  const app = createApp(logger)
  // Stop background work before closing the pool it uses.
  app.addHook('onClose', async () => {
    await sweeper.stop()
    await pool.end()
  })

  await app.register(healthPlugin, { checks: { postgres: () => pool.query('SELECT 1') } })
  await app.register(movieRoutes, { prefix: '/movies', pool })
  await app.register(theatreRoutes, { prefix: '/theatres', pool })
  await app.register(showRoutes, { prefix: '/shows', pool })
  // Writes, grouped by who may do them (each group checks the role itself).
  await app.register(vendorRoutes, { prefix: '/vendor', pool })
  await app.register(adminRoutes, { prefix: '/admin', pool })
  // Saga steps, for our own services only.
  await app.register(internalRoutes, {
    prefix: '/internal',
    reservations,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
  })

  await startServer(app, { port: config.INVENTORY_SERVICE_PORT, logger })
}

main().catch((err: unknown) => {
  console.error('inventory-service failed to start', err)
  process.exit(1)
})
