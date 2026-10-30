import { baseEnvSchema, internalServiceToken, loadConfig, port } from '@bookwise/common'
import { z } from 'zod'

export const config = loadConfig(
  baseEnvSchema.extend({
    PAYMENT_SERVICE_PORT: port(3003),
    PAYMENT_DB_URL: z.url(),
    RUN_MIGRATIONS: z.stringbool().default(true),
    INTERNAL_SERVICE_TOKEN: internalServiceToken(),
    // Fake payment provider: share of cards declined (0..1) and response time.
    PAYMENT_DECLINE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    PAYMENT_PROVIDER_LATENCY_MS: z.coerce.number().int().min(0).default(0),
  }),
)
