import { randomUUID } from 'node:crypto'
import { type Caller, createApp, createLogger, type Pool } from '@bookwise/common'
import { describe, expect, it } from 'vitest'
import { canManageTheatre } from './ownership'
import adminRoutes from './routes/admin'
import vendorRoutes from './routes/vendor'

const vendorA: Caller = { id: randomUUID(), role: 'vendor', email: 'a@test.com' }
const vendorB: Caller = { id: randomUUID(), role: 'vendor', email: 'b@test.com' }
const admin: Caller = { id: randomUUID(), role: 'admin', email: 'admin@test.com' }
const customer: Caller = { id: randomUUID(), role: 'customer', email: 'c@test.com' }

describe('canManageTheatre', () => {
  it('lets a vendor manage only their own theatre', () => {
    expect(canManageTheatre(vendorA, vendorA.id)).toBe(true)
    expect(canManageTheatre(vendorB, vendorA.id)).toBe(false)
  })

  it('lets an admin manage any theatre, including legacy ones without an owner', () => {
    expect(canManageTheatre(admin, vendorA.id)).toBe(true)
    expect(canManageTheatre(admin, null)).toBe(true)
    expect(canManageTheatre(vendorA, null)).toBe(false)
  })

  it('never lets a customer manage a theatre', () => {
    expect(canManageTheatre({ ...customer, id: vendorA.id }, vendorA.id)).toBe(false)
  })
})

describe('role guards on route groups (defence in depth)', () => {
  // A pool that fails the test if touched: the guard must reject the request
  // before any database work happens.
  const untouchablePool = {
    query: () => {
      throw new Error('database must not be reached')
    },
    connect: () => {
      throw new Error('database must not be reached')
    },
  } as unknown as Pool

  const buildApp = async () => {
    const app = createApp(createLogger({ service: 'inventory-test', level: 'silent' }))
    await app.register(vendorRoutes, { prefix: '/vendor', pool: untouchablePool })
    await app.register(adminRoutes, { prefix: '/admin', pool: untouchablePool })
    return app
  }
  const headersFor = (caller: Caller) => ({
    'x-user-id': caller.id,
    'x-user-role': caller.role,
    'x-user-email': caller.email,
  })

  it('rejects requests without gateway identity headers (401)', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/vendor/theatres' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a customer on vendor routes and a vendor on admin routes (403)', async () => {
    const app = await buildApp()
    const asCustomer = await app.inject({
      method: 'GET',
      url: '/vendor/theatres',
      headers: headersFor(customer),
    })
    expect(asCustomer.statusCode).toBe(403)

    const asVendor = await app.inject({
      method: 'POST',
      url: '/admin/movies',
      headers: headersFor(vendorA),
      payload: { title: 'Dune', duration_mins: 155 },
    })
    expect(asVendor.statusCode).toBe(403)
  })

  it('does not let an admin create a theatre (theatres belong to vendors)', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/vendor/theatres',
      headers: headersFor(admin),
      payload: { name: 'PVR', city: 'Pune', address: 'FC Road' },
    })
    expect(res.statusCode).toBe(403)
  })
})
