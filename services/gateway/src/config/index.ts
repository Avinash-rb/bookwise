import { baseEnvSchema, loadConfig, port } from '@bookwise/common'
import { z } from 'zod'

const env = loadConfig(
  baseEnvSchema.extend({
    GATEWAY_PORT: port(3000),
    // No fallback: a gateway that silently signs tokens with a well-known
    // default secret is a gateway anyone can forge tokens for.
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    ORDER_SERVICE_URL: z.url().default('http://localhost:3001'),
    INVENTORY_SERVICE_URL: z.url().default('http://localhost:3002'),
    PAYMENT_SERVICE_URL: z.url().default('http://localhost:3003'),
  }),
)

const config = {
  port: env.GATEWAY_PORT,
  jwtSecret: env.JWT_SECRET,
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  services: {
    order: env.ORDER_SERVICE_URL,
    inventory: env.INVENTORY_SERVICE_URL,
    payment: env.PAYMENT_SERVICE_URL,
  },
}

export default config
