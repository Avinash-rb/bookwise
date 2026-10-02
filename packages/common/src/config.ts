import { z } from 'zod'

// Every service validates its environment at startup and refuses to boot if
// something is missing or malformed. Failing fast here beats discovering a
// typo'd DATABASE_URL on the first request in production.

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback)

export function loadConfig<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(env)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return result.data
}
