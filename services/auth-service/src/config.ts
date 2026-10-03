import { baseEnvSchema, loadConfig, port } from '@bookwise/common'
import { z } from 'zod'

// Compose passes unset optional variables as "" — treat that as "not provided".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

export const config = loadConfig(
  baseEnvSchema
    .extend({
      AUTH_SERVICE_PORT: port(3004),
      AUTH_DB_URL: z.url(),
      RUN_MIGRATIONS: z.stringbool().default(true),
      // Path to the RSA private key (PEM). Generate one with `npm run keys:generate`.
      JWT_PRIVATE_KEY_FILE: z.string().min(1),
      JWT_ISSUER: z.string().min(1).default('bookwise-auth'),
      JWT_AUDIENCE: z.string().min(1).default('bookwise'),
      ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
      REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
      // Optional: seed one admin account at startup (nobody can register as admin).
      ADMIN_EMAIL: optional(z.email()),
      ADMIN_PASSWORD: optional(z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters')),
    })
    .refine((env) => (env.ADMIN_EMAIL === undefined) === (env.ADMIN_PASSWORD === undefined), {
      message: 'ADMIN_EMAIL and ADMIN_PASSWORD must be set together',
      path: ['ADMIN_PASSWORD'],
    }),
)
