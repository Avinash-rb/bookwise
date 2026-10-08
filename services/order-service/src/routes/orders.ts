import { getCaller, notFound, type Pool, requireRole, roleGuard, withTransaction } from '@bookwise/common'
import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import { canViewOrder } from '../ownership'
import type { Saga } from '../services/saga'

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

// No customer field: who is ordering comes from the verified token (the
// x-user-* headers), never from the request body.
const CreateOrderBody = Type.Object({
  show_id: Type.String({ format: 'uuid' }),
  seat_ids: Type.Array(Type.String({ format: 'uuid' }), {
    minItems: 1,
    maxItems: 10,
    uniqueItems: true,
  }),
  // TODO: price tampering. The client still sends the amount; the saga PR
  // makes inventory's seat prices the source of truth.
  total_amount: Type.Number({ exclusiveMinimum: 0 }),
})

const orderRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; saga: Saga }> = async (app, { pool, saga }) => {
  // Orders are a customer thing; admins may look at them for support.
  app.addHook('onRequest', roleGuard('customer', 'admin'))

  // GET /orders/:id — order with its seats, only for its owner (or an admin).
  app.get('/:id', { schema: { params: IdParams } }, async (request) => {
    const caller = getCaller(request)
    const { id } = request.params
    const order = (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0]

    // Someone else's order gets the SAME 404 as a missing one. A 403 would
    // confirm that the id exists; orders are private, so reveal nothing.
    if (!order || !canViewOrder(caller, order.customer_id)) throw notFound('Order not found')

    const seats = await pool.query('SELECT * FROM order_seats WHERE order_id = $1', [id])
    return { ...order, seats: seats.rows }
  })

  // GET /orders — my orders, newest first (an admin sees the latest 100 of all)
  app.get('/', async (request) => {
    const caller = getCaller(request)
    const result =
      caller.role === 'admin'
        ? await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100')
        : await pool.query('SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC', [
            caller.id,
          ])
    return result.rows
  })

  // POST /orders — create the order (PENDING) and run the booking saga.
  // Still synchronous for now. TODO: return 202 Accepted and run the saga in a durable worker.
  app.post('/', { schema: { body: CreateOrderBody } }, async (request, reply) => {
    const customer = requireRole(request, 'customer')
    const { show_id, seat_ids, total_amount } = request.body

    // 1. Persist the order and commit, releasing the DB connection BEFORE the
    //    saga makes slow network calls (holding it would exhaust the pool).
    const order = await withTransaction(pool, async (client) => {
      const created = (
        await client.query(
          `INSERT INTO orders (customer_id, customer_email, show_id, total_amount, status)
           VALUES ($1, $2, $3, $4, 'PENDING')
           RETURNING *`,
          [customer.id, customer.email, show_id, total_amount],
        )
      ).rows[0]

      await client.query(
        `INSERT INTO order_seats (order_id, show_seat_id, price)
         SELECT $1, seat_id, $3 FROM unnest($2::uuid[]) AS seat_id`,
        [created.id, seat_ids, total_amount / seat_ids.length],
      )

      await client.query(
        `INSERT INTO saga_logs (order_id, step, action, payload)
         VALUES ($1, 'CREATE_ORDER', 'COMPLETED', $2)`,
        [created.id, JSON.stringify({ customer_id: customer.id, show_id, seat_ids })],
      )
      return created
    })

    // 2. Run the saga
    const sagaResult = await saga.execute(order.id, show_id, seat_ids, total_amount)
    return reply.status(201).send({ order_id: order.id, ...sagaResult })
  })
}

export default orderRoutes
