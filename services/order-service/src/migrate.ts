// `npm run migrate` — apply pending migrations without starting the server.
import path from 'node:path'
import { createLogger, createPool, runMigrations } from '@bookwise/common'
import { config } from './config'

const logger = createLogger({ service: 'order-migrate', level: config.LOG_LEVEL, pretty: true })
const pool = createPool(config.ORDER_DB_URL, logger)

runMigrations(pool, path.join(__dirname, '..', 'migrations'), logger)
  .then(() => pool.end())
  .catch(async (err: unknown) => {
    logger.fatal({ err }, 'migration failed')
    await pool.end()
    process.exit(1)
  })
