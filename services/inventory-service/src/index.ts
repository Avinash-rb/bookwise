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
import movieRoutes from './routes/movies'
import showRoutes from './routes/shows'
import theatreRoutes from './routes/theatres'
import vendorRoutes from './routes/vendor'

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

  const app = createApp(logger)
  app.addHook('onClose', () => pool.end())

  await app.register(healthPlugin, { checks: { postgres: () => pool.query('SELECT 1') } })
  await app.register(movieRoutes, { prefix: '/movies', pool })
  await app.register(theatreRoutes, { prefix: '/theatres', pool })
  await app.register(showRoutes, { prefix: '/shows', pool })
  // Writes, grouped by who may do them (each group checks the role itself).
  await app.register(vendorRoutes, { prefix: '/vendor', pool })
  await app.register(adminRoutes, { prefix: '/admin', pool })

  await startServer(app, { port: config.INVENTORY_SERVICE_PORT, logger })
}

main().catch((err: unknown) => {
  console.error('inventory-service failed to start', err)
  process.exit(1)
})
