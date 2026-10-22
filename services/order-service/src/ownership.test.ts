import { randomUUID } from 'node:crypto'
import { type Caller, createApp, createLogger, type Pool } from '@bookwise/common'
import { describe, expect, it } from 'vitest'
import { canViewOrder } from './ownership'
import orderRoutes from './routes/orders'

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
  const worker = { wake: () => {} }

  const buildApp = async () => {
    const app = createApp(createLogger({ service: 'order-test', level: 'silent' }))
    await app.register(orderRoutes, { prefix: '/orders', pool, worker })
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
})

describe('POST /orders', () => {
  const showId = randomUUID()
  const seatId = randomUUID()
  const asAlice = { 'x-user-id': alice.id, 'x-user-role': 'customer', 'x-user-email': alice.email }

  // A fake DB client. `existing` simulates an order already stored under the
  // same Idempotency-Key (then the INSERT ... ON CONFLICT DO NOTHING returns no row).
  const setup = (existing?: { show_id: string; seat_ids: string[] }) => {
    const calls = { insertedOrder: [] as unknown[], wakes: 0 }
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO orders')) {
          calls.insertedOrder = params
          return { rows: existing ? [] : [{ id: 'new-order', status: 'PENDING' }] }
        }
        if (sql.includes('idempotency_key = $2') && existing) {
          return { rows: [{ id: 'earlier-order', status: 'CONFIRMED', ...existing }] }
        }
        return { rows: [] }
      },
      release: () => {},
    }
    const build = async () => {
      const app = createApp(createLogger({ service: 'order-test', level: 'silent' }))
      await app.register(orderRoutes, {
        prefix: '/orders',
        pool: { connect: async () => client } as unknown as Pool,
        worker: { wake: () => calls.wakes++ },
      })
      return app
    }
    return { calls, build }
  }

  it('accepts the order with 202 and wakes the saga worker', async () => {
    const { calls, build } = setup()
    const res = await (await build()).inject({
      method: 'POST',
      url: '/orders',
      headers: asAlice,
      payload: { show_id: showId, seat_ids: [seatId] },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ order_id: 'new-order', status: 'PENDING', replayed: false })
    expect(calls.wakes).toBe(1)
  })

  it('takes the customer from the token and the price from nowhere the client controls', async () => {
    const { calls, build } = setup()
    await (await build()).inject({
      method: 'POST',
      url: '/orders',
      headers: asAlice,
      payload: { customer_email: 'victim@test.com', total_amount: 1, show_id: showId, seat_ids: [seatId] },
    })
    expect(calls.insertedOrder.slice(0, 2)).toEqual([alice.id, alice.email])
    expect(calls.insertedOrder).not.toContain('victim@test.com')
    expect(calls.insertedOrder).not.toContain(1) // no client price is stored
  })

  it('same Idempotency-Key, same request: returns the earlier order, books nothing new', async () => {
    const { calls, build } = setup({ show_id: showId, seat_ids: [seatId] })
    const res = await (await build()).inject({
      method: 'POST',
      url: '/orders',
      headers: { ...asAlice, 'idempotency-key': 'checkout-123' },
      payload: { show_id: showId, seat_ids: [seatId] },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ order_id: 'earlier-order', status: 'CONFIRMED', replayed: true })
    expect(calls.wakes).toBe(0)
  })

  it('same Idempotency-Key, different seats: 422', async () => {
    const { build } = setup({ show_id: showId, seat_ids: [randomUUID()] })
    const res = await (await build()).inject({
      method: 'POST',
      url: '/orders',
      headers: { ...asAlice, 'idempotency-key': 'checkout-123' },
      payload: { show_id: showId, seat_ids: [seatId] },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
  })
})
