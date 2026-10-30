import { internalOnly, notFound } from '@bookwise/common'
import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import type { Payments } from '../payments'

const OrderIdParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) })

const ChargeBody = Type.Object({
  order_id: Type.String({ format: 'uuid' }),
  // Money as a decimal string ("500.00"), never a float.
  amount: Type.String({ pattern: '^[0-9]{1,8}(\\.[0-9]{1,2})?$' }),
})

// Called only by the order saga (internal token required; the gateway has no
// route to payment-service at all).
const internalRoutes: FastifyPluginAsyncTypebox<{ payments: Payments; internalToken: string }> = async (
  app,
  { payments, internalToken },
) => {
  app.addHook('onRequest', internalOnly(internalToken))

  // POST /internal/payments — charge an order. 200 = paid, 402 = declined,
  // 422 = this order was already charged a different amount. Repeating the
  // same request returns the stored result.
  app.post('/payments', { schema: { body: ChargeBody } }, async (request, reply) => {
    const payment = await payments.charge(request.body.order_id, request.body.amount)
    return reply.status(payment.status === 'FAILED' ? 402 : 200).send(payment)
  })

  // POST /internal/payments/:orderId/refund — compensation; always 200.
  app.post('/payments/:orderId/refund', { schema: { params: OrderIdParams } }, async (request) =>
    payments.refund(request.params.orderId),
  )

  // GET /internal/payments/:orderId — what happened to this order's payment.
  app.get('/payments/:orderId', { schema: { params: OrderIdParams } }, async (request) => {
    const payment = await payments.get(request.params.orderId)
    if (!payment) throw notFound('No payment for this order')
    return payment
  })
}

export default internalRoutes
