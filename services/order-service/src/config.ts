import { baseEnvSchema, internalServiceToken, loadConfig, port } from '@bookwise/common'
import { z } from 'zod'

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback)

export const config = loadConfig(
  baseEnvSchema.extend({
    ORDER_SERVICE_PORT: port(3001),
    ORDER_DB_URL: z.url(),
    INVENTORY_SERVICE_URL: z.url().default('http://localhost:3002'),
    PAYMENT_SERVICE_URL: z.url().default('http://localhost:3003'),
    RUN_MIGRATIONS: z.stringbool().default(true),
    INTERNAL_SERVICE_TOKEN: internalServiceToken(),
    // Saga worker
    SAGA_POLL_INTERVAL_MS: positiveInt(500), // how often to look for due orders
    SAGA_BATCH_SIZE: positiveInt(10), // orders handled in parallel per loop
    SAGA_STEP_TIMEOUT_MS: positiveInt(5_000), // one HTTP call to another service
    SAGA_LEASE_SECONDS: positiveInt(30), // claim length; must exceed the step timeout
    SAGA_MAX_ATTEMPTS: positiveInt(5), // tries per step before giving up
  }),
)
