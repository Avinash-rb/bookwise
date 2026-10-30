import { AppError, getCaller, type Pool, roleGuard } from '@bookwise/common'
import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import type { SagaWorker } from '../saga/worker'

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })
const ListQuery = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal('NEEDS_ATTENTION'),
      Type.Literal('PENDING'),
      Type.Literal('FAILED'),
      Type.Literal('CONFIRMED'),
    ]),
  ),
})

// Support tools. When the saga gives up after taking money (or can't finish a
// compensation), it parks the order as NEEDS_ATTENTION instead of guessing.
// A human looks at it, fixes the cause (e.g. payment provider back up), and
// retries it from the step where it stopped.
const adminRoutes: FastifyPluginAsyncTypebox<{ pool: Pool; worker: Pick<SagaWorker, 'wake'> }> = async (
  app,
  { pool, worker },
) => {
  app.addHook('onRequest', roleGuard('admin'))

  // GET /admin/orders?status=NEEDS_ATTENTION — the queue a support engineer works through.
  // Includes the internals customers never see: step, attempts, last error.
  app.get('/orders', { schema: { querystring: ListQuery } }, async (request) => {
    const { rows } = await pool.query(
      `SELECT id, status, saga_step, failure_reason, attempts, last_error, total_amount,
              customer_email, created_at, updated_at
       FROM orders WHERE status = $1 ORDER BY updated_at DESC LIMIT 100`,
      [request.query.status ?? 'NEEDS_ATTENTION'],
    )
    return rows
  })

  // POST /admin/orders/:id/retry — resume a parked saga from its current step
  // with a fresh set of attempts.
  app.post('/orders/:id/retry', { schema: { params: IdParams } }, async (request) => {
    const admin = getCaller(request)
    const { rows } = await pool.query(
      `UPDATE orders
       SET status = 'PENDING', attempts = 0, next_run_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'NEEDS_ATTENTION'
       RETURNING id, status, saga_step`,
      [request.params.id],
    )
    const order = rows[0]
    if (!order) throw new AppError(409, 'NOT_RETRYABLE', 'Only orders in NEEDS_ATTENTION can be retried')

    await pool.query(
      `INSERT INTO saga_logs (order_id, step, action, payload) VALUES ($1, $2, 'STARTED', $3)`,
      [order.id, order.saga_step, JSON.stringify({ retried_by: admin.id })],
    )
    worker.wake()
    return order
  })
}

export default adminRoutes
