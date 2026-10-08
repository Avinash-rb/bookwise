import { randomUUID } from 'node:crypto'
import { type Caller, createApp, createLogger, type Pool } from '@bookwise/common'
import { describe, expect, it } from 'vitest'
import { canViewOrder } from './ownership'
import orderRoutes from './routes/orders'
import type { Saga } from './services/saga'

const alice: Caller = { id: randomUUID(), role: 'customer', email: 'alice@test.com' }
const bob: Caller = { id: randomUUID(), role: 'customer', email: 'bob@test.com' }
const admin: Caller = { id: randomUUID(), role: 'admin', email: 'admin@test.com' }
const vendor: Caller = { id: randomUUID(), role: 'vendor', email: 'v@test.com' }

describe('canViewOrder', () => {
  it('lets a customer see only their own orders', () => {
    expect(canViewOrder(alice, alice.id)).toBe(true)
    expect(canViewOrder(bob, alice.id)).toBe(false)
  })

  it('lets an admin see any order, including legacy orders without an owner', () => {
    expect(canViewOrder(admin, alice.id)).toBe(true)
    expect(canViewOrder(admin, null)).toBe(true)
    expect(canViewOrder(alice, null)).toBe(false)
  })

  it('never lets a vendor see an order', () => {
    expect(canViewOrder({ ...vendor, id: alice.id }, alice.id)).toBe(false)
  })
})

describe('order routes', () => {
  const orderId = randomUUID()
  // One order belonging to Alice; enough to exercise the ownership check.
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM orders WHERE id')) {
        return { rows: [{ id: orderId, customer_id: alice.id, status: 'CONFIRMED' }] }
      }
      return { rows: [] }
    },
  } as unknown as Pool
  const saga = {} as Saga

  const buildApp = async () => {
    const app = createApp(createLogger({ service: 'order-test', level: 'silent' }))
    await app.register(orderRoutes, { prefix: '/orders', pool, saga })
    return app
  }
  const getOrderAs = async (caller: Caller, id = orderId) =>
    (await buildApp()).inject({
      method: 'GET',
      url: `/orders/${id}`,
      headers: { 'x-user-id': caller.id, 'x-user-role': caller.role, 'x-user-email': caller.email },
    })

  it('returns the order to its owner', async () => {
    const res = await getOrderAs(alice)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: orderId, seats: [] })
  })

  it("answers someone else's order exactly like a missing one (404, same body)", async () => {
    const othersOrder = await getOrderAs(bob)
    const missingOrder = await (await buildApp()).inject({
      method: 'GET',
      url: `/orders/${randomUUID()}`,
      headers: { 'x-user-id': bob.id, 'x-user-role': 'customer', 'x-user-email': bob.email },
    })
    expect(othersOrder.statusCode).toBe(404)
    expect(othersOrder.json()).toEqual(missingOrder.json())
  })

  it('rejects vendors on order routes (403) and anonymous calls (401)', async () => {
    expect((await getOrderAs(vendor)).statusCode).toBe(403)
    const anonymous = await (await buildApp()).inject({ method: 'GET', url: `/orders/${orderId}` })
    expect(anonymous.statusCode).toBe(401)
  })

  it('does not let an admin place orders', async () => {
    const res = await (await buildApp()).inject({
      method: 'POST',
      url: '/orders',
      headers: { 'x-user-id': admin.id, 'x-user-role': 'admin', 'x-user-email': admin.email },
      payload: { show_id: randomUUID(), seat_ids: [randomUUID()], total_amount: 100 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('takes the customer from the token, ignoring a customer_email in the body', async () => {
    // Records the parameters of the INSERT INTO orders statement.
    let insertedOrder: unknown[] = []
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO orders')) {
          insertedOrder = params
          return { rows: [{ id: orderId }] }
        }
        return { rows: [] }
      },
      release: () => {},
    }
    const app = createApp(createLogger({ service: 'order-test', level: 'silent' }))
    await app.register(orderRoutes, {
      prefix: '/orders',
      pool: { connect: async () => client } as unknown as Pool,
      saga: { execute: async () => ({ status: 'CONFIRMED' }) } as unknown as Saga,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'x-user-id': alice.id, 'x-user-role': 'customer', 'x-user-email': alice.email },
      payload: {
        customer_email: 'victim@test.com',
        show_id: randomUUID(),
        seat_ids: [randomUUID()],
        total_amount: 100,
      },
    })
    expect(res.statusCode).toBe(201)
    expect(insertedOrder.slice(0, 2)).toEqual([alice.id, alice.email])
    expect(insertedOrder).not.toContain('victim@test.com')
  })
})
