import fp from 'fastify-plugin'

export type HealthCheck = () => Promise<unknown>

export interface HealthOptions {
  checks?: Record<string, HealthCheck>
  timeoutMs?: number
}

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })

// Two probes, because they answer different questions:
//   /health/live  -> "is the process alive?"            (restart it if not)
//   /health/ready -> "can it serve traffic right now?"  (stop routing to it if not)
// A service whose DB is down is alive but not ready; restarting it would not help.
export const healthPlugin = fp<HealthOptions>(
  async (app, { checks = {}, timeoutMs = 2_000 }) => {
    app.get('/health/live', { logLevel: 'warn' }, async () => ({ status: 'ok' }))

    app.get('/health/ready', { logLevel: 'warn' }, async (request, reply) => {
      const results = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
          try {
            await withTimeout(check(), timeoutMs)
            return [name, 'ok'] as const
          } catch (err) {
            request.log.warn({ err, check: name }, 'readiness check failed')
            return [name, 'fail'] as const
          }
        }),
      )
      const ready = results.every(([, status]) => status === 'ok')
      return reply
        .status(ready ? 200 : 503)
        .send({ status: ready ? 'ok' : 'unavailable', checks: Object.fromEntries(results) })
    })
  },
  { name: 'bookwise-health' },
)
