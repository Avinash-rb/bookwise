import { Type } from '@fastify/type-provider-typebox'
import { describe, expect, it } from 'vitest'
import { conflict } from './errors'
import { healthPlugin } from './health'
import { createLogger } from './logger'
import { createApp } from './server'

const buildApp = () => createApp(createLogger({ service: 'test', level: 'silent' }))

describe('error handling', () => {
  it('maps AppError to its status and a consistent body', async () => {
    const app = buildApp()
    app.get('/boom', async () => {
      throw conflict('Seat taken', { seat: 'A1' })
    })
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'CONFLICT',
      message: 'Seat taken',
      details: { seat: 'A1' },
    })
  })

  it('rejects requests that fail schema validation with 400', async () => {
    const app = buildApp()
    app.post(
      '/items',
      { schema: { body: Type.Object({ id: Type.String({ format: 'uuid' }) }) } },
      async () => 'ok',
    )
    const res = await app.inject({ method: 'POST', url: '/items', payload: { id: 'nope' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('VALIDATION_ERROR')
  })

  it('translates Postgres constraint errors instead of returning 500', async () => {
    const app = buildApp()
    app.get('/dup', async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
    })
    const res = await app.inject({ method: 'GET', url: '/dup' })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).not.toMatch(/duplicate key/) // no DB internals leaked
  })

  it('hides internal error details behind a generic 500', async () => {
    const app = buildApp()
    app.get('/bug', async () => {
      throw new Error('connection string postgres://secret@db')
    })
    const res = await app.inject({ method: 'GET', url: '/bug' })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('secret')
  })

  it('returns 404 with a consistent body for unknown routes', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/missing' })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('ROUTE_NOT_FOUND')
  })

  it('propagates an incoming x-request-id', async () => {
    const app = buildApp()
    app.get('/ping', async () => 'pong')
    const res = await app.inject({ method: 'GET', url: '/ping', headers: { 'x-request-id': 'abc-123' } })
    expect(res.headers['x-request-id']).toBe('abc-123')
  })
})

describe('health probes', () => {
  it('is ready when every check passes', async () => {
    const app = buildApp()
    await app.register(healthPlugin, { checks: { postgres: async () => 'ok' } })
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', checks: { postgres: 'ok' } })
  })

  it('is NOT ready (503) when a dependency fails or hangs, but still live', async () => {
    const app = buildApp()
    await app.register(healthPlugin, {
      timeoutMs: 50,
      checks: {
        postgres: async () => {
          throw new Error('ECONNREFUSED')
        },
        redis: () => new Promise(() => {}), // never resolves
      },
    })
    const ready = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json().checks).toEqual({ postgres: 'fail', redis: 'fail' })

    const live = await app.inject({ method: 'GET', url: '/health/live' })
    expect(live.statusCode).toBe(200)
  })
})
