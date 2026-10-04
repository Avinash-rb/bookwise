import { randomUUID } from 'node:crypto'
import { type App, createApp, createLogger } from '@bookwise/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import rateLimitPlugin, { byIp } from './rateLimit'
import redisPlugin from './redis'

// Runs the real Lua script, so it needs a real Redis:
//   REDIS_URL=redis://localhost:6379 npx vitest run services/gateway
// Skipped when REDIS_URL isn't set.
const REDIS_URL = process.env.REDIS_URL

describe.runIf(REDIS_URL)('Redis token bucket', () => {
  // Two gateway "replicas" with separate Redis connections, sharing buckets.
  const replicas: App[] = []
  const policy = () => ({ name: `test-${randomUUID()}`, capacity: 5, refillPerSecond: 5 })

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const app = createApp(createLogger({ service: 'gateway-test', level: 'silent' }))
      await app.register(redisPlugin, { url: REDIS_URL ?? '' })
      await app.register(rateLimitPlugin)
      replicas.push(app)
    }
    await Promise.all(replicas.map((app) => app.ready()))
  })

  afterAll(async () => {
    await Promise.all(replicas.map((app) => app.close()))
  })

  // Calls one rate-limit check outside of any route and reports the outcome.
  async function attempt(app: App, p: ReturnType<typeof policy>) {
    const headers: Record<string, unknown> = {}
    const reply = { header: (k: string, v: unknown) => (headers[k] = v) }
    const request = { ip: '203.0.113.7', log: app.log }
    try {
      await app.rateLimit(p, byIp)(request as never, reply as never)
      return { allowed: true, headers }
    } catch (err) {
      return { allowed: false, status: (err as { statusCode: number }).statusCode, headers }
    }
  }

  it('allows a burst up to capacity, then rejects with 429 and Retry-After', async () => {
    const p = policy()
    const results = []
    for (let i = 0; i < 7; i++) results.push(await attempt(replicas[0] as App, p))

    expect(results.filter((r) => r.allowed)).toHaveLength(5)
    expect(results[4]?.headers['ratelimit-remaining']).toBe(0)
    expect(results[5]).toMatchObject({ allowed: false, status: 429 })
    expect(results[5]?.headers['retry-after']).toBe(1)
  })

  it('is shared and atomic across replicas: 40 concurrent requests -> exactly 5 allowed', async () => {
    const p = policy()
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => attempt(replicas[i % 2] as App, p)),
    )
    expect(results.filter((r) => r.allowed)).toHaveLength(5)
  })

  it('refills over time', async () => {
    const p = policy() // 5 tokens/second
    for (let i = 0; i < 5; i++) await attempt(replicas[0] as App, p)
    expect((await attempt(replicas[0] as App, p)).allowed).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 450)) // ~2 tokens earned
    const after = [await attempt(replicas[1] as App, p), await attempt(replicas[1] as App, p)]
    expect(after.every((r) => r.allowed)).toBe(true)
  })

  it('lets idle buckets expire so Redis does not fill up', async () => {
    const p = policy()
    await attempt(replicas[0] as App, p)
    const ttl = await (replicas[0] as App).redis.ttl(`ratelimit:${p.name}:203.0.113.7`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(1) // capacity / rate = 5 / 5 = 1 second
  })
})
