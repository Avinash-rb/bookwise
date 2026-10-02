import { notFound, type Pool, withTransaction } from '@bookwise/common'
import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import type { Saga } from '../services/saga'

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

const ListOrdersQuery = Type.Object({ email: Type.String({ format: 'email' }) })

const CreateOrderBody = Type.Object({
  customer_email: Type.String({ format: 'email', maxLength: 255 }),
  show_id: Type.String({ format: 'uuid' }),
  seat_ids: Type.Array(Type.String({ format: 'uuid' }), {
    minItems: 1,
    maxItems: 10,
    uniqueItems: true,
  }),
  total_amount: Type.Number({ exclusiveMinimum: 0 }),
})

const orderRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; saga: Saga }> = async (app, { pool, saga }) => {
  // GET /orders/:id — order with its seats
  app.get('/:id', { schema: { params: IdParams } }, async (request) => {
    const { id } = request.params
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [id])
    if (order.rows.length === 0) throw notFound('Order not found')

    const seats = await pool.query('SELECT * FROM order_seats WHERE order_id = $1', [id])
    return { ...order.rows[0], seats: seats.rows }
  })

  // GET /orders?email=... — orders for a customer
  app.get('/', { schema: { querystring: ListOrdersQuery } }, async (request) => {
    const result = await pool.query(
      'SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC',
      [request.query.email],
    )
    return result.rows
  })

  // POST /orders — create the order (PENDING) and run the booking saga.
  // Still synchronous for now; Day 3 turns this into 202 Accepted + a durable worker.
  app.post('/', { schema: { body: CreateOrderBody } }, async (request, reply) => {
    const { customer_email, show_id, seat_ids, total_amount } = request.body

    // 1. Persist the order and commit, releasing the DB connection BEFORE the
    //    saga makes slow network calls (holding it would exhaust the pool).
    const order = await withTransaction(pool, async (client) => {
      const created = (
        await client.query(
          `INSERT INTO orders (customer_email, show_id, total_amount, status)
           VALUES ($1, $2, $3, 'PENDING')
           RETURNING *`,
          [customer_email, show_id, total_amount],
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
        [created.id, JSON.stringify({ customer_email, show_id, seat_ids })],
      )
      return created
    })

    // 2. Run the saga
    const sagaResult = await saga.execute(order.id, show_id, seat_ids, total_amount)
    return reply.status(201).send({ order_id: order.id, ...sagaResult })
  })
}

export default orderRoutes
