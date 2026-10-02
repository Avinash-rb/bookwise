// ─────────────────────────────────────────────────────────────
// BookWise Saga Orchestrator
//
// Flow:
//   1. Reserve Seats   → Inventory Service
//   2. Process Payment → Payment Service
//   3. Confirm Seats   → Inventory Service
//
// Compensation (on failure):
//   - Payment failed? → Release seats
//   - Confirm failed? → Refund payment + Release seats
//
// NOTE: this is still the original synchronous, in-request orchestrator (only
// dependency-injected and logged properly). Day 3 replaces it with a durable,
// crash-safe background worker; Day 4 adds retries and a circuit breaker.
// ─────────────────────────────────────────────────────────────

import { type Logger, type Pool, withTransaction } from '@bookwise/common'

export interface SagaDeps {
  pool: Pool
  logger: Logger
  inventoryUrl: string
  paymentUrl: string
}

export interface SagaResult {
  success: boolean
  status: string
  message: string
}

export type Saga = ReturnType<typeof createSaga>

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Downstream responses are untrusted JSON; only the fields the saga reads are typed.
interface DownstreamBody {
  message?: string
  status?: string
  provider_reference?: string
  [key: string]: unknown
}
const readJson = async (res: Response): Promise<DownstreamBody> => {
  const body: unknown = await res.json().catch(() => ({}))
  return typeof body === 'object' && body !== null ? (body as DownstreamBody) : {}
}

export function createSaga({ pool, logger, inventoryUrl, paymentUrl }: SagaDeps) {
  // Update order status + append a saga log row, atomically
  const updateOrderStatus = (
    orderId: string,
    status: string,
    step: string,
    action: string,
    payload: object = {},
  ) =>
    withTransaction(pool, async (client) => {
      await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [status, orderId])
      await client.query(
        `INSERT INTO saga_logs (order_id, step, action, payload)
         VALUES ($1, $2, $3, $4)`,
        [orderId, step, action, JSON.stringify(payload)],
      )
    })

  const postJson = (url: string, body: object) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  // ── Compensations ─────────────────────────────────────────
  async function compensateReleaseSeats(orderId: string, showId: string) {
    try {
      await postJson(`${inventoryUrl}/shows/${showId}/release`, { order_id: orderId })
      await updateOrderStatus(orderId, 'FAILED', 'RELEASE_SEATS', 'COMPENSATED')
      logger.info({ orderId }, 'compensation: seats released')
    } catch (err) {
      logger.error({ err, orderId }, 'compensation failed: could not release seats')
    }
  }

  async function compensateRefundPayment(orderId: string) {
    try {
      await postJson(`${paymentUrl}/payments/refund`, { order_id: orderId })
      await updateOrderStatus(orderId, 'FAILED', 'REFUND_PAYMENT', 'COMPENSATED')
      logger.info({ orderId }, 'compensation: payment refunded')
    } catch (err) {
      logger.error({ err, orderId }, 'compensation failed: could not refund payment')
    }
  }

  // ── Main saga ─────────────────────────────────────────────
  async function execute(
    orderId: string,
    showId: string,
    seatIds: string[],
    totalAmount: number,
  ): Promise<SagaResult> {
    const log = logger.child({ orderId })
    log.info('saga started')

    // STEP 1: Reserve seats
    try {
      await updateOrderStatus(orderId, 'PENDING', 'RESERVE_SEATS', 'STARTED')
      const res = await postJson(`${inventoryUrl}/shows/${showId}/reserve`, {
        seat_ids: seatIds,
        order_id: orderId,
      })
      if (!res.ok) {
        const error = await readJson(res)
        await updateOrderStatus(orderId, 'FAILED', 'RESERVE_SEATS', 'FAILED', error)
        log.warn({ error }, 'saga failed at step 1 (reserve seats)')
        return { success: false, status: 'FAILED', message: `Seat reservation failed: ${error.message}` }
      }
      await updateOrderStatus(orderId, 'SEATS_RESERVED', 'RESERVE_SEATS', 'COMPLETED')
      log.info('step 1: seats reserved')
    } catch (err) {
      await updateOrderStatus(orderId, 'FAILED', 'RESERVE_SEATS', 'FAILED', { error: errorMessage(err) })
      return { success: false, status: 'FAILED', message: `Seat reservation error: ${errorMessage(err)}` }
    }

    // STEP 2: Process payment
    try {
      await updateOrderStatus(orderId, 'SEATS_RESERVED', 'PROCESS_PAYMENT', 'STARTED')
      const res = await postJson(`${paymentUrl}/payments`, {
        order_id: orderId,
        amount: totalAmount,
        idempotency_key: orderId, // same key on every retry -> never charged twice
      })
      const payment = await readJson(res)

      if (!res.ok || payment.status === 'FAILED') {
        log.warn('payment failed, compensating: releasing seats')
        await compensateReleaseSeats(orderId, showId)
        await updateOrderStatus(orderId, 'FAILED', 'PROCESS_PAYMENT', 'FAILED', payment)
        return { success: false, status: 'FAILED', message: 'Payment failed. Seats released.' }
      }

      await updateOrderStatus(orderId, 'PAYMENT_COMPLETED', 'PROCESS_PAYMENT', 'COMPLETED', payment)
      log.info({ providerReference: payment.provider_reference }, 'step 2: payment processed')
    } catch (err) {
      await compensateReleaseSeats(orderId, showId)
      await updateOrderStatus(orderId, 'FAILED', 'PROCESS_PAYMENT', 'FAILED', { error: errorMessage(err) })
      return { success: false, status: 'FAILED', message: `Payment error: ${errorMessage(err)}` }
    }

    // STEP 3: Confirm seats
    try {
      await updateOrderStatus(orderId, 'PAYMENT_COMPLETED', 'CONFIRM_SEATS', 'STARTED')
      const res = await postJson(`${inventoryUrl}/shows/${showId}/confirm`, { order_id: orderId })

      if (!res.ok) {
        const error = await readJson(res)
        log.warn('confirm failed, compensating: refund + release')
        await compensateRefundPayment(orderId)
        await compensateReleaseSeats(orderId, showId)
        await updateOrderStatus(orderId, 'FAILED', 'CONFIRM_SEATS', 'FAILED', error)
        return { success: false, status: 'FAILED', message: 'Seat confirmation failed. Refunded.' }
      }

      await updateOrderStatus(orderId, 'CONFIRMED', 'CONFIRM_SEATS', 'COMPLETED')
      log.info('saga completed: order confirmed')
      return { success: true, status: 'CONFIRMED', message: 'Booking confirmed!' }
    } catch (err) {
      await compensateRefundPayment(orderId)
      await compensateReleaseSeats(orderId, showId)
      await updateOrderStatus(orderId, 'FAILED', 'CONFIRM_SEATS', 'FAILED', { error: errorMessage(err) })
      return { success: false, status: 'FAILED', message: `Confirm error: ${errorMessage(err)}` }
    }
  }

  return { execute }
}
