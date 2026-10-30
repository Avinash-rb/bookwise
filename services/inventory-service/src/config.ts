import { baseEnvSchema, internalServiceToken, loadConfig, port } from '@bookwise/common'
import { z } from 'zod'

export const config = loadConfig(
  baseEnvSchema.extend({
    INVENTORY_SERVICE_PORT: port(3002),
    INVENTORY_DB_URL: z.url(),
    RUN_MIGRATIONS: z.stringbool().default(true),
    INTERNAL_SERVICE_TOKEN: internalServiceToken(),
    // How long a seat stays held while the customer pays.
    RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    // How often expired holds are released.
    SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  }),
)
