import { FastifyInstance } from 'fastify'
import pool from '../db/client'
import { ProcessPaymentBody } from '../types'

export default async function paymentRoutes(app: FastifyInstance) {

  // GET /payments/:id
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await pool.query(
      'SELECT * FROM payments WHERE id = $1', [id]
    )
    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Payment not found' })
    }
    return result.rows[0]
  })

  // POST /payments — process payment with idempotency
  app.post('/', async (request, reply) => {
    const { order_id, amount, idempotency_key } =
      request.body as ProcessPaymentBody

    if (!order_id || !amount || !idempotency_key) {
      return reply.status(400).send({
        error: 'order_id, amount, idempotency_key required'
      })
    }

    const client = await pool.connect()
    try {
      // ── Idempotency Check ──────────────────────────────────
      // If we've already processed this key, return stored result
      const existing = await client.query(
        'SELECT * FROM idempotency_keys WHERE key = $1',
        [idempotency_key]
      )

      if (existing.rows.length > 0) {
        // Already processed — return original response (don't charge again!)
        return reply
          .status(existing.rows[0].status_code)
          .send(existing.rows[0].response_body)
      }
      // ──────────────────────────────────────────────────────

      await client.query('BEGIN')

      // Simulate payment processing
      // In production: call Razorpay/Stripe API here
      const success = Math.random() > 0.1  // 90% success rate (10% simulate failure)
      const status = success ? 'COMPLETED' : 'FAILED'
      const providerRef = success ? `PAY_${Date.now()}` : null

      const paymentResult = await client.query(
        `INSERT INTO payments (order_id, amount, status, provider_reference)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [order_id, amount, status, providerRef]
      )
      const payment = paymentResult.rows[0]

      // Store in idempotency table
      const responseBody = payment
      const statusCode = success ? 201 : 402

      await client.query(
        `INSERT INTO idempotency_keys (key, response_body, status_code)
         VALUES ($1, $2, $3)`,
        [idempotency_key, JSON.stringify(responseBody), statusCode]
      )

      await client.query('COMMIT')
      return reply.status(statusCode).send(responseBody)

    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // POST /payments/refund — refund a payment (compensation in saga)
  app.post('/refund', async (request, reply) => {
    const { order_id } = request.body as { order_id: string }

    const result = await pool.query(
      `UPDATE payments
       SET status = 'REFUNDED', updated_at = NOW()
       WHERE order_id = $1 AND status = 'COMPLETED'
       RETURNING *`,
      [order_id]
    )

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'No completed payment found for this order'
      })
    }

    return { message: 'Refund processed', payment: result.rows[0] }
  })
}
