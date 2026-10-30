import { randomUUID } from 'node:crypto'
import { createApp, createLogger } from '@bookwise/common'
import { describe, expect, it } from 'vitest'
import {
  checkConfirm,
  checkReserve,
  formatCents,
  type Reservations,
  type SeatRow,
  toCents,
} from './reservations'
import internalRoutes from './routes/internal'

const ORDER = randomUUID()
const OTHER_ORDER = randomUUID()

const seat = (status: SeatRow['status'], reservedBy: string | null = null): SeatRow => ({
  id: randomUUID(),
  status,
  reserved_by_order: reservedBy,
})

describe('checkReserve (all-or-nothing)', () => {
  it('accepts free seats', () => {
    expect(checkReserve([seat('AVAILABLE'), seat('AVAILABLE')], 2, ORDER)).toEqual({ kind: 'ok' })
  })

  it('treats seats already held by the same order as fine (idempotent retry)', () => {
    expect(checkReserve([seat('RESERVED', ORDER), seat('AVAILABLE')], 2, ORDER)).toEqual({ kind: 'ok' })
  })

  it('rejects the whole request if any seat belongs to another order', () => {
    const taken = seat('RESERVED', OTHER_ORDER)
    const booked = seat('BOOKED', OTHER_ORDER)
    expect(checkReserve([seat('AVAILABLE'), taken, booked], 3, ORDER)).toEqual({
      kind: 'unavailable',
      seatIds: [taken.id, booked.id],
    })
  })

  it('rejects when a requested seat is not part of the show', () => {
    expect(checkReserve([seat('AVAILABLE')], 2, ORDER)).toEqual({ kind: 'missing' })
  })
})

describe('checkConfirm', () => {
  it('confirms when the order still holds every seat', () => {
    expect(checkConfirm([seat('RESERVED', ORDER), seat('RESERVED', ORDER)], 2, ORDER)).toBe('CONFIRM')
  })

  it('is idempotent: already booked by this order', () => {
    expect(checkConfirm([seat('BOOKED', ORDER), seat('BOOKED', ORDER)], 2, ORDER)).toBe('ALREADY_CONFIRMED')
  })

  it('finishes a half-applied confirm (some booked, some reserved)', () => {
    expect(checkConfirm([seat('BOOKED', ORDER), seat('RESERVED', ORDER)], 2, ORDER)).toBe('CONFIRM')
  })

  it('reports the reservation lost if even one seat was released or taken', () => {
    expect(checkConfirm([seat('RESERVED', ORDER), seat('AVAILABLE')], 2, ORDER)).toBe('LOST')
    expect(checkConfirm([seat('RESERVED', ORDER), seat('RESERVED', OTHER_ORDER)], 2, ORDER)).toBe('LOST')
  })
})

describe('money in integer cents', () => {
  it('parses Postgres NUMERIC strings without floating point', () => {
    expect(toCents('250.00')).toBe(25_000)
    expect(toCents('0.1')).toBe(10)
    expect(toCents('99')).toBe(9_900)
  })

  it('adds up exactly where floats would not', () => {
    expect(0.1 + 0.2).not.toBe(0.3) // the reason for cents
    expect(formatCents(toCents('0.10') + toCents('0.20'))).toBe('0.30')
    expect(formatCents(5)).toBe('0.05')
  })
})

describe('internal routes', () => {
  const TOKEN = 'internal-token-for-tests-0123456789abcdef'
  const untouchable = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('reservations must not be reached')
      },
    },
  ) as Reservations

  const buildApp = async () => {
    const app = createApp(createLogger({ service: 'inventory-test', level: 'silent' }))
    await app.register(internalRoutes, {
      prefix: '/internal',
      reservations: untouchable,
      internalToken: TOKEN,
    })
    return app
  }
  const body = { order_id: ORDER, show_id: randomUUID(), seat_ids: [randomUUID()] }

  it('rejects calls without the service token (401), before doing any work', async () => {
    const app = await buildApp()
    for (const headers of [{}, { 'x-internal-token': 'wrong' }]) {
      const res = await app.inject({ method: 'POST', url: '/internal/reservations', headers, payload: body })
      expect(res.statusCode).toBe(401)
    }
  })

  it('validates the request once the token is right (400 for a bad body)', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reservations',
      headers: { 'x-internal-token': TOKEN },
      payload: { ...body, seat_ids: [] },
    })
    expect(res.statusCode).toBe(400)
  })
})
