import { AppError, conflict, notFound, type Pool, withTransaction } from '@bookwise/common'

// Seat holds for the booking saga. Every operation here is IDEMPOTENT: the
// order service retries after timeouts, so "already done for this order" must
// count as success, never as an error.
//
// Lock-order rule: every statement that locks several seats locks them in id
// order (ORDER BY id ... FOR UPDATE). Two orders wanting seats {A, B} and
// {B, A} then both queue on A first, so they can never deadlock.

export interface SeatRow {
  id: string
  status: 'AVAILABLE' | 'RESERVED' | 'BOOKED'
  reserved_by_order: string | null
}

// Already reserved or booked by this very order (e.g. a retried request).
const heldBy = (seat: SeatRow, orderId: string) =>
  seat.status !== 'AVAILABLE' && seat.reserved_by_order === orderId

export type ReserveCheck = { kind: 'ok' } | { kind: 'missing' } | { kind: 'unavailable'; seatIds: string[] }

// All-or-nothing: every requested seat must exist in the show and be free
// (or already held by this order).
export function checkReserve(rows: SeatRow[], requestedCount: number, orderId: string): ReserveCheck {
  if (rows.length !== requestedCount) return { kind: 'missing' }
  const unavailable = rows.filter((s) => s.status !== 'AVAILABLE' && !heldBy(s, orderId)).map((s) => s.id)
  return unavailable.length > 0 ? { kind: 'unavailable', seatIds: unavailable } : { kind: 'ok' }
}

export type ConfirmCheck = 'CONFIRM' | 'ALREADY_CONFIRMED' | 'LOST'

// Confirm only if the order still holds EVERY one of its seats. If even one
// was released (hold expired and swept), the reservation is lost: booking only
// part of an order would be wrong, so the saga refunds instead.
export function checkConfirm(rows: SeatRow[], requestedCount: number, orderId: string): ConfirmCheck {
  if (rows.length !== requestedCount || !rows.every((s) => heldBy(s, orderId))) return 'LOST'
  return rows.every((s) => s.status === 'BOOKED') ? 'ALREADY_CONFIRMED' : 'CONFIRM'
}

// Money as integer cents, never floats: 0.1 + 0.2 !== 0.3 in floating point.
// Postgres NUMERIC arrives as a string like "250.00".
export function toCents(amount: string): number {
  const [whole = '0', fraction = ''] = amount.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2))
}
export const formatCents = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

export const reservationLost = () =>
  new AppError(409, 'RESERVATION_LOST', 'The seat reservation expired or was released')

export interface ReserveInput {
  orderId: string
  showId: string
  seatIds: string[]
}

export function createReservations({ pool, ttlSeconds }: { pool: Pool; ttlSeconds: number }) {
  async function reserve({ orderId, showId, seatIds }: ReserveInput) {
    return withTransaction(pool, async (client) => {
      /* FOR UPDATE OF ss: lock only the seat rows. Locking the joined shows row too would make every booking for the same show queue up behind each other, even for different seats.*/
      const { rows } = await client.query<SeatRow & { price: string }>(
        `SELECT ss.id, ss.status, ss.reserved_by_order, sh.price
         FROM show_seats ss
         JOIN shows sh ON sh.id = ss.show_id
         WHERE ss.id = ANY($1::uuid[]) AND ss.show_id = $2
         ORDER BY ss.id
         FOR UPDATE OF ss`,
        [seatIds, showId],
      )

      const check = checkReserve(rows, seatIds.length, orderId)
      if (check.kind === 'missing') throw notFound('Some seats do not exist in this show')
      if (check.kind === 'unavailable') {
        throw conflict('Some seats are no longer available', { unavailable_seat_ids: check.seatIds })
      }

      // Hold (or, on a retry, re-hold) the seats. BOOKED seats are left alone.
      const held = await client.query<{ reserved_until: Date }>(
        `UPDATE show_seats
         SET status = 'RESERVED', reserved_by_order = $1,
             reserved_at = COALESCE(reserved_at, now()),
             reserved_until = now() + make_interval(secs => $3)
         WHERE id = ANY($2::uuid[]) AND status <> 'BOOKED'
         RETURNING reserved_until`,
        [orderId, seatIds, ttlSeconds],
      )

      // The price comes from OUR data, so the client can't choose what it pays.
      const totalCents = rows.reduce((sum, seat) => sum + toCents(seat.price), 0)
      return {
        order_id: orderId,
        show_id: showId,
        seats: rows.map((seat) => ({ show_seat_id: seat.id, price: seat.price })),
        total_amount: formatCents(totalCents),
        reserved_until: held.rows[0]?.reserved_until.toISOString() ?? null,
      }
    })
  }

  async function confirm(orderId: string, seatIds: string[]) {
    return withTransaction(pool, async (client) => {
      const { rows } = await client.query<SeatRow>(
        `SELECT id, status, reserved_by_order FROM show_seats
         WHERE id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [seatIds],
      )
      // A hold past its reserved_until but not yet swept is still this
      // order's: nobody else can have the seats, so confirming is safe.
      const check = checkConfirm(rows, seatIds.length, orderId)
      if (check === 'LOST') throw reservationLost()

      if (check === 'CONFIRM') {
        await client.query(
          `UPDATE show_seats SET status = 'BOOKED', reserved_until = NULL
           WHERE id = ANY($1::uuid[]) AND status = 'RESERVED'`,
          [seatIds],
        )
      }
      return { order_id: orderId, status: 'BOOKED', already_confirmed: check === 'ALREADY_CONFIRMED' }
    })
  }

  // Compensation. Releases whatever this order still holds (possibly nothing,
  // which is fine). Never touches BOOKED seats: a confirmed ticket isn't
  // undone by a saga compensation.
  async function release(orderId: string) {
    const { rows } = await pool.query(
      `UPDATE show_seats
       SET status = 'AVAILABLE', reserved_by_order = NULL, reserved_at = NULL, reserved_until = NULL
       WHERE id IN (
         SELECT id FROM show_seats
         WHERE reserved_by_order = $1 AND status = 'RESERVED'
         ORDER BY id
         FOR UPDATE
       )
       RETURNING id`,
      [orderId],
    )
    return { order_id: orderId, released: rows.length }
  }

  // Frees expired holds. SKIP LOCKED: seats being reserved or confirmed right
  // now are skipped (picked up next round), so the sweeper never blocks a
  // booking and two inventory replicas never sweep the same seats.
  async function sweepExpired(batchSize = 500) {
    const { rows } = await pool.query<{ order_id: string }>(
      `WITH expired AS (
         SELECT id, reserved_by_order FROM show_seats
         WHERE status = 'RESERVED' AND reserved_until < now()
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE show_seats ss
       SET status = 'AVAILABLE', reserved_by_order = NULL, reserved_at = NULL, reserved_until = NULL
       FROM expired
       WHERE ss.id = expired.id
       RETURNING expired.reserved_by_order AS order_id`,
      [batchSize],
    )
    return { seats: rows.length, orders: [...new Set(rows.map((r) => r.order_id))] }
  }

  return { reserve, confirm, release, sweepExpired }
}

export type Reservations = ReturnType<typeof createReservations>
