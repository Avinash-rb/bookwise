import { baseEnvSchema, loadConfig, port } from '@bookwise/common'
import { z } from 'zod'

export const config = loadConfig(
  baseEnvSchema.extend({
    PAYMENT_SERVICE_PORT: port(3003),
    PAYMENT_DB_URL: z.url(),
    RUN_MIGRATIONS: z.stringbool().default(true),
  }),
)
