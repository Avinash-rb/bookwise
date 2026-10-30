import {
  AppError,
  getCaller,
  notFound,
  type Pool,
  requireRole,
  roleGuard,
  withTransaction,
} from '@bookwise/common'
import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import { canViewOrder } from '../ownership'
import type { SagaWorker } from '../saga/worker'

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

// No customer and no price: who orders comes from the verified token, and what
// it costs comes from inventory (the saga sets the total after reserving).
const CreateOrderBody = Type.Object({
  show_id: Type.String({ format: 'uuid' }),
  seat_ids: Type.Array(Type.String({ format: 'uuid' }), {
    minItems: 1,
    maxItems: 10,
    uniqueItems: true,
  }),
})

const CreateOrderHeaders = Type.Object({
  'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
})

// What customers see. Internals (lease, version, last technical error) stay out.
const ORDER_COLUMNS = `id, status, saga_step, failure_reason, show_id, total_amount,
  customer_email, created_at, updated_at`

const idempotencyKeyReused = () =>
  new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different order')

const sameSeats = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

const orderRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; worker: Pick<SagaWorker, 'wake'> }> = async (
  app,
  { pool, worker },
) => {
  // Orders are a customer thing; admins may look at them for support.
  app.addHook('onRequest', roleGuard('customer', 'admin'))

  // GET /orders/:id — poll this to follow a booking: PENDING -> CONFIRMED/FAILED.
  app.get('/:id', { schema: { params: IdParams } }, async (request) => {
    const caller = getCaller(request)
    const { id } = request.params
    const order = (await pool.query(`SELECT ${ORDER_COLUMNS}, customer_id FROM orders WHERE id = $1`, [id]))
      .rows[0]

    // Someone else's order gets the SAME 404 as a missing one. A 403 would
    // confirm that the id exists; orders are private, so reveal nothing.
    if (!order || !canViewOrder(caller, order.customer_id)) throw notFound('Order not found')

    const seats = await pool.query('SELECT show_seat_id, price FROM order_seats WHERE order_id = $1', [id])
    const { customer_id: _owner, ...visible } = order
    return { ...visible, seats: seats.rows }
  })

  // GET /orders — my orders, newest first (an admin sees the latest 100 of all)
  app.get('/', async (request) => {
    const caller = getCaller(request)
    const result =
      caller.role === 'admin'
        ? await pool.query(`SELECT ${ORDER_COLUMNS} FROM orders ORDER BY created_at DESC LIMIT 100`)
        : await pool.query(
            `SELECT ${ORDER_COLUMNS} FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
            [caller.id],
          )
    return result.rows
  })

  // POST /orders — accept the booking and return at once (202). The saga
  // worker does the slow part (reserve, pay, confirm) in the background.
  //
  // Idempotency-Key header (optional, recommended): sending the same key again
  // — a double click, a retry after a dropped connection — returns the SAME
  // order instead of booking twice.
  app.post(
    '/',
    { schema: { body: CreateOrderBody, headers: CreateOrderHeaders } },
    async (request, reply) => {
      const customer = requireRole(request, 'customer')
      const { show_id, seat_ids } = request.body
      const key = request.headers['idempotency-key'] ?? null

      const result = await withTransaction(pool, async (client) => {
        // ON CONFLICT DO NOTHING: if two identical requests race, the unique
        // index lets exactly one insert; the other finds the existing order.
        const inserted = await client.query<{ id: string; status: string }>(
          `INSERT INTO orders (customer_id, customer_email, show_id, status, idempotency_key)
           VALUES ($1, $2, $3, 'PENDING', $4)
           ON CONFLICT (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING id, status`,
          [customer.id, customer.email, show_id, key],
        )
        const created = inserted.rows[0]

        if (created) {
          // Prices stay empty until inventory has priced the reserved seats.
          await client.query(
            `INSERT INTO order_seats (order_id, show_seat_id)
             SELECT $1, seat_id FROM unnest($2::uuid[]) AS seat_id`,
            [created.id, seat_ids],
          )
          await client.query(
            `INSERT INTO saga_logs (order_id, step, action, payload)
             VALUES ($1, 'CREATE_ORDER', 'COMPLETED', $2)`,
            [created.id, JSON.stringify({ customer_id: customer.id, show_id, seat_ids })],
          )
          return { order: created, replayed: false }
        }

        // The key was used before: hand back that order, if it's the same request.
        const existing = await client.query<{
          id: string
          status: string
          show_id: string
          seat_ids: string[]
        }>(
          `SELECT o.id, o.status, o.show_id,
             ARRAY(SELECT show_seat_id::text FROM order_seats WHERE order_id = o.id) AS seat_ids
           FROM orders o WHERE o.customer_id = $1 AND o.idempotency_key = $2`,
          [customer.id, key],
        )
        const previous = existing.rows[0]
        if (!previous || previous.show_id !== show_id || !sameSeats(previous.seat_ids, seat_ids)) {
          throw idempotencyKeyReused()
        }
        return { order: { id: previous.id, status: previous.status }, replayed: true }
      })

      if (!result.replayed) worker.wake()
      return reply.status(202).send({
        order_id: result.order.id,
        status: result.order.status,
        replayed: result.replayed, // true = this key was seen before, nothing new was booked
      })
    },
  )
}

export default orderRoutes
