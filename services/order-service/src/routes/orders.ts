import { FastifyInstance } from 'fastify'
import pool from '../db/client'
import { CreateOrderBody } from '../types'
import { executeSaga } from '../services/saga'

export default async function orderRoutes(app: FastifyInstance) {

  // GET /orders/:id — get order by ID with its seats
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string }

    const orderResult = await pool.query(
      'SELECT * FROM orders WHERE id = $1',
      [id]
    )

    if (orderResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Order not found' })
    }

    // Also fetch the seats for this order
    const seatsResult = await pool.query(
      'SELECT * FROM order_seats WHERE order_id = $1',
      [id]
    )

    return {
      ...orderResult.rows[0],
      seats: seatsResult.rows
    }
  })

  // GET /orders?email=... — get orders by customer email
  app.get('/', async (request, reply) => {
    const { email } = request.query as { email?: string }

    if (!email) {
      return reply.status(400).send({ error: 'email query param required' })
    }

    const result = await pool.query(
      'SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC',
      [email]
    )

    return result.rows
  })

  // POST /orders — create a new order (PENDING state)
  // NOTE: This does NOT reserve seats yet — that's the Saga's job (Day 6)
  // This just creates the order record so we have an ID to work with
  app.post('/', async (request, reply) => {
    const { customer_email, show_id, seat_ids, total_amount } =
      request.body as CreateOrderBody

    if (!customer_email || !show_id || !seat_ids?.length || !total_amount) {
      return reply.status(400).send({
        error: 'customer_email, show_id, seat_ids, total_amount required'
      })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Create the order in PENDING state
      const orderResult = await client.query(
        `INSERT INTO orders (customer_email, show_id, total_amount, status)
         VALUES ($1, $2, $3, 'PENDING')
         RETURNING *`,
        [customer_email, show_id, total_amount]
      )
      const order = orderResult.rows[0]

      // 2. Record which seats are part of this order
      for (const showSeatId of seat_ids) {
        await client.query(
          `INSERT INTO order_seats (order_id, show_seat_id, price)
           VALUES ($1, $2, $3)`,
          [order.id, showSeatId, total_amount / seat_ids.length]
        )
      }

      // 3. Log first saga step
      await client.query(
        `INSERT INTO saga_logs (order_id, step, action, payload)
         VALUES ($1, 'CREATE_ORDER', 'COMPLETED', $2)`,
        [order.id, JSON.stringify({ customer_email, show_id, seat_ids })]
      )

      await client.query('COMMIT')

      // 🎬 Trigger the saga (async — don't await in production)
      // For now we await to get the result synchronously
      const sagaResult = await executeSaga(
        order.id,
        show_id,
        seat_ids,
        total_amount
      )

      return reply.status(201).send({
        order_id: order.id,
        ...sagaResult
      })


    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // PATCH /orders/:id/status — internal route to update order status (used by Saga)
  app.patch('/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { status, step, action, payload } =
      request.body as {
        status: string
        step: string
        action: string
        payload?: object
      }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Update order status
      const result = await client.query(
        `UPDATE orders
         SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [status, id]
      )

      if (result.rows.length === 0) {
        await client.query('ROLLBACK')
        return reply.status(404).send({ error: 'Order not found' })
      }

      // Log the saga step
      await client.query(
        `INSERT INTO saga_logs (order_id, step, action, payload)
         VALUES ($1, $2, $3, $4)`,
        [id, step, action, JSON.stringify(payload ?? {})]
      )

      await client.query('COMMIT')
      return result.rows[0]

    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}
