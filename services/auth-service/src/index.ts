import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createApp,
  createLogger,
  createPool,
  healthPlugin,
  runMigrations,
  startServer,
} from '@bookwise/common'
import { createAuthService } from './auth.service'
import { config } from './config'
import authRoutes from './routes/auth'
import { createTokenIssuer } from './tokens'

async function loadPrivateKey(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    throw new Error(
      `Cannot read JWT private key at "${file}". Generate one with \`npm run keys:generate\`.`,
      { cause: err },
    )
  }
}

async function main() {
  const logger = createLogger({
    service: 'auth-service',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  })

  const tokens = createTokenIssuer({
    privateKeyPem: await loadPrivateKey(config.JWT_PRIVATE_KEY_FILE),
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  })

  const pool = createPool(config.AUTH_DB_URL, logger, { application_name: 'auth-service' })

  if (config.RUN_MIGRATIONS) {
    await runMigrations(pool, path.join(__dirname, '..', 'migrations'), logger)
  }

  const auth = createAuthService({
    pool,
    logger,
    tokens,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: config.REFRESH_TOKEN_TTL_DAYS,
  })

  if (config.ADMIN_EMAIL && config.ADMIN_PASSWORD) {
    await auth.seedAdmin(config.ADMIN_EMAIL, config.ADMIN_PASSWORD)
  }

  const app = createApp(logger)
  app.addHook('onClose', () => pool.end())

  await app.register(healthPlugin, { checks: { postgres: () => pool.query('SELECT 1') } })
  await app.register(authRoutes, { prefix: '/auth', auth, tokens })

  logger.info({ kid: tokens.kid }, 'token signing key loaded')
  await startServer(app, { port: config.AUTH_SERVICE_PORT, logger })
}

main().catch((err: unknown) => {
  console.error('auth-service failed to start', err)
  process.exit(1)
})
