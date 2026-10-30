import { randomUUID } from 'node:crypto'
import { createApp, createLogger, type Pool } from '@bookwise/common'
import { describe, expect, it } from 'vitest'
import adminRoutes from './admin'

const ORDER = randomUUID()
const admin = { 'x-user-id': randomUUID(), 'x-user-role': 'admin', 'x-user-email': 'admin@test.com' }

// `parked`: whether the fake order is currently NEEDS_ATTENTION.
const build = async (parked: boolean) => {
  const calls = { wakes: 0, sql: [] as string[] }
  const pool = {
    query: async (sql: string) => {
      calls.sql.push(sql)
      if (sql.includes('UPDATE orders')) {
        return { rows: parked ? [{ id: ORDER, status: 'PENDING', saga_step: 'REFUND_PAYMENT' }] : [] }
      }
      return { rows: [] }
    },
  } as unknown as Pool
  const app = createApp(createLogger({ service: 'order-test', level: 'silent' }))
  await app.register(adminRoutes, { prefix: '/admin', pool, worker: { wake: () => calls.wakes++ } })
  return { app, calls }
}

describe('admin retry of parked sagas', () => {
  it('resumes a NEEDS_ATTENTION order from its current step and wakes the worker', async () => {
    const { app, calls } = await build(true)
    const res = await app.inject({ method: 'POST', url: `/admin/orders/${ORDER}/retry`, headers: admin })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: ORDER, status: 'PENDING', saga_step: 'REFUND_PAYMENT' })
    expect(calls.wakes).toBe(1)
  })

  it('refuses to "retry" an order that is not parked (409)', async () => {
    const { app, calls } = await build(false)
    const res = await app.inject({ method: 'POST', url: `/admin/orders/${ORDER}/retry`, headers: admin })
    expect(res.statusCode).toBe(409)
    expect(calls.wakes).toBe(0)
  })

  it('is admin-only', async () => {
    const { app } = await build(true)
    const res = await app.inject({
      method: 'GET',
      url: '/admin/orders',
      headers: { ...admin, 'x-user-role': 'customer' },
    })
    expect(res.statusCode).toBe(403)
  })
})
