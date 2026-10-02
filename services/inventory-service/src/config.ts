import { baseEnvSchema, loadConfig, port } from '@bookwise/common'
import { z } from 'zod'

export const config = loadConfig(
  baseEnvSchema.extend({
    INVENTORY_SERVICE_PORT: port(3002),
    INVENTORY_DB_URL: z.url(),
    RUN_MIGRATIONS: z.stringbool().default(true),
  }),
)
