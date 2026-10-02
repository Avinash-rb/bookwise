import { baseEnvSchema, loadConfig, port } from '@bookwise/common'
import { z } from 'zod'

export const config = loadConfig(
  baseEnvSchema.extend({
    ORDER_SERVICE_PORT: port(3001),
    ORDER_DB_URL: z.url(),
    INVENTORY_SERVICE_URL: z.url().default('http://localhost:3002'),
    PAYMENT_SERVICE_URL: z.url().default('http://localhost:3003'),
    RUN_MIGRATIONS: z.stringbool().default(true),
  }),
)
