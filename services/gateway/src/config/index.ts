import { readFileSync } from 'node:fs'
import { baseEnvSchema, loadConfig, port } from '@bookwise/common'
import { z } from 'zod'

const env = loadConfig(
  baseEnvSchema.extend({
    GATEWAY_PORT: port(3000),
    // The gateway only holds the PUBLIC key: it can verify tokens but never
    // mint them. The private key stays inside auth-service.
    JWT_PUBLIC_KEY_FILE: z.string().min(1),
    JWT_ISSUER: z.string().default('bookwise-auth'),
    JWT_AUDIENCE: z.string().default('bookwise'),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    AUTH_SERVICE_URL: z.url().default('http://localhost:3004'),
    ORDER_SERVICE_URL: z.url().default('http://localhost:3001'),
    INVENTORY_SERVICE_URL: z.url().default('http://localhost:3002'),
    // How long the gateway waits for a service before answering 504.
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    // Comma-separated browser origins allowed by CORS (the Vite dev server by default).
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.url())),
  }),
)

const config = {
  port: env.GATEWAY_PORT,
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  jwt: {
    // Read once at startup: a missing key file should stop the gateway from
    // booting, not fail on the first request.
    publicKeyPem: readFileSync(env.JWT_PUBLIC_KEY_FILE, 'utf8'),
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  },
  redisUrl: env.REDIS_URL,
  upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
  corsOrigins: env.CORS_ORIGINS,
  services: {
    auth: env.AUTH_SERVICE_URL,
    order: env.ORDER_SERVICE_URL,
    inventory: env.INVENTORY_SERVICE_URL,
  },
}

export type Upstream = keyof typeof config.services

export default config
