import { notFound, type Pool, withTransaction } from '@bookwise/common'
import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

const ProcessPaymentBody = Type.Object({
  order_id: Type.String({ format: 'uuid' }),
  amount: Type.Number({ exclusiveMinimum: 0 }),
  idempotency_key: Type.String({ minLength: 1, maxLength: 255 }),
})

const RefundBody = Type.Object({ order_id: Type.String({ format: 'uuid' }) })

// NOTE: payment logic is unchanged from the original version; Day 4 replaces it
// with a race-free idempotency flow and a real (fake) payment provider.
const paymentRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (app, { pool }) => {
  // GET /payments/:id
  app.get('/:id', { schema: { params: IdParams } }, async (request) => {
    const result = await pool.query('SELECT * FROM payments WHERE id = $1', [request.params.id])
    if (result.rows.length === 0) throw notFound('Payment not found')
    return result.rows[0]
  })

  // POST /payments — process payment with idempotency
  app.post('/', { schema: { body: ProcessPaymentBody } }, async (request, reply) => {
    const { order_id, amount, idempotency_key } = request.body

    // If we've already processed this key, return the stored result (don't charge again)
    const existing = await pool.query(
      'SELECT status_code, response_body FROM idempotency_keys WHERE key = $1',
      [idempotency_key],
    )
    if (existing.rows.length > 0) {
      return reply.status(existing.rows[0].status_code).send(existing.rows[0].response_body)
    }

    const { statusCode, payment } = await withTransaction(pool, async (client) => {
      // Simulated payment provider: 90% success rate
      const success = Math.random() > 0.1
      const paymentResult = await client.query(
        `INSERT INTO payments (order_id, amount, status, provider_reference)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [order_id, amount, success ? 'COMPLETED' : 'FAILED', success ? `PAY_${Date.now()}` : null],
      )
      const created = paymentResult.rows[0]
      const code = success ? 201 : 402

      await client.query(
        `INSERT INTO idempotency_keys (key, response_body, status_code)
         VALUES ($1, $2, $3)`,
        [idempotency_key, JSON.stringify(created), code],
      )
      return { statusCode: code, payment: created }
    })

    return reply.status(statusCode).send(payment)
  })

  // POST /payments/refund — refund a payment (saga compensation)
  app.post('/refund', { schema: { body: RefundBody } }, async (request) => {
    const result = await pool.query(
      `UPDATE payments
       SET status = 'REFUNDED', updated_at = now()
       WHERE order_id = $1 AND status = 'COMPLETED'
       RETURNING *`,
      [request.body.order_id],
    )
    if (result.rows.length === 0) throw notFound('No completed payment found for this order')
    return { message: 'Refund processed', payment: result.rows[0] }
  })
}

export default paymentRoutes
