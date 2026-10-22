import { internalOnly } from '@bookwise/common'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Reservations } from '../reservations'
import { ConfirmReservationBody, CreateReservationBody, OrderIdParams, ReservationResponse } from '../schemas'

// Service-to-service endpoints for the booking saga. Not in the gateway's
// route table, and they also require the shared internal token.
// A reservation is identified by its order id: one order, one seat hold.
const internalRoutes: FastifyPluginAsyncTypebox<{
  reservations: Reservations
  internalToken: string
}> = async (app, { reservations, internalToken }) => {
  app.addHook('onRequest', internalOnly(internalToken))

  // POST /internal/reservations — hold seats for an order, priced by us.
  // 409 if any seat is taken; repeating the call for the same order is a no-op.
  app.post(
    '/reservations',
    { schema: { body: CreateReservationBody, response: { 200: ReservationResponse } } },
    async (request) => {
      const { order_id, show_id, seat_ids } = request.body
      return reservations.reserve({ orderId: order_id, showId: show_id, seatIds: seat_ids })
    },
  )

  // POST /internal/reservations/:orderId/confirm — RESERVED -> BOOKED.
  // 409 RESERVATION_LOST if the hold expired and was released.
  app.post(
    '/reservations/:orderId/confirm',
    { schema: { params: OrderIdParams, body: ConfirmReservationBody } },
    async (request) => reservations.confirm(request.params.orderId, request.body.seat_ids),
  )

  // POST /internal/reservations/:orderId/release — compensation; always 200.
  app.post('/reservations/:orderId/release', { schema: { params: OrderIdParams } }, async (request) =>
    reservations.release(request.params.orderId),
  )
}

export default internalRoutes
