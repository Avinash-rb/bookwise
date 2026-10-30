import {
  type CircuitBreaker,
  createCircuitBreaker,
  INTERNAL_TOKEN_HEADER,
  type Logger,
} from '@bookwise/common'
import type { SagaStep, StepOutcome } from './decide'

// One order, as claimed by the worker.
export interface SagaOrder {
  id: string
  step: SagaStep
  attempts: number
  version: number
  show_id: string
  total_amount: string | null
  seat_ids: string[]
}

export interface StepResult {
  outcome: StepOutcome
  // Filled by RESERVE_SEATS: inventory's prices become the order's prices.
  reservation?: { total_amount: string; seats: { show_seat_id: string; price: string }[] }
}

export interface StepDeps {
  inventoryUrl: string
  paymentUrl: string
  internalToken: string
  timeoutMs: number
  logger: Logger
}

// "Try again later" vs "no". 5xx / 408 / 429 are the other side's temporary
// trouble. 401/403 on a service-to-service call mean OUR credentials were
// refused — a deployment problem, not the customer's fault — so we retry
// (and end with a human) rather than tell the customer "seats unavailable".
export const isTransientStatus = (status: number) =>
  status >= 500 || status === 408 || status === 429 || status === 401 || status === 403

type Reply = { status: number; body: Record<string, unknown> } | { error: string }

export function createStepRunner({ inventoryUrl, paymentUrl, internalToken, timeoutMs, logger }: StepDeps) {
  // One circuit breaker per service we call. When payment is down, its
  // breaker opens and payment steps fail instantly instead of each waiting
  // 5 s for a timeout; inventory steps are unaffected.
  const breakerFor = (upstream: string) =>
    createCircuitBreaker({
      failureThreshold: 5,
      resetMs: 10_000,
      onStateChange: (from, to) => logger.warn({ upstream, from, to }, `circuit breaker ${to}`),
    })
  const inventory = breakerFor('inventory-service')
  const payment = breakerFor('payment-service')

  async function post(breaker: CircuitBreaker, url: string, body: object = {}): Promise<Reply> {
    // Circuit open: don't even try. For the saga it's a temporary failure:
    // the step is retried later with backoff, when the circuit may be closed.
    if (!breaker.allow()) return { error: 'circuit open' }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: internalToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const json: unknown = await res.json().catch(() => ({}))
      // A business "no" (409, 402...) still means the service is healthy.
      if (isTransientStatus(res.status)) breaker.failure()
      else breaker.success()
      return {
        status: res.status,
        body: typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {},
      }
    } catch (err) {
      // Timeout, connection refused, DNS... we don't know if it was done.
      breaker.failure()
      return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
    }
  }

  // Maps a non-success reply to an outcome. `reasons` names the business
  // "no"s this step can get (e.g. 409 -> SEATS_UNAVAILABLE).
  function failure(reply: Reply, reasons: Record<number, string>): StepOutcome {
    if ('error' in reply) return { type: 'transient', error: reply.error }
    if (isTransientStatus(reply.status)) return { type: 'transient', error: `HTTP ${reply.status}` }
    return { type: 'rejected', reason: reasons[reply.status] ?? `HTTP_${reply.status}` }
  }
  const ok: StepResult = { outcome: { type: 'ok' } }
  const succeeded = (reply: Reply, ...statuses: number[]) =>
    'status' in reply && statuses.includes(reply.status)

  async function runStep(order: SagaOrder): Promise<StepResult> {
    const reservation = `${inventoryUrl}/internal/reservations/${order.id}`
    const paymentOf = `${paymentUrl}/internal/payments`

    switch (order.step) {
      case 'RESERVE_SEATS': {
        const reply = await post(inventory, `${inventoryUrl}/internal/reservations`, {
          order_id: order.id,
          show_id: order.show_id,
          seat_ids: order.seat_ids,
        })
        if (succeeded(reply, 200) && 'body' in reply) {
          return { ...ok, reservation: reply.body as StepResult['reservation'] }
        }
        return { outcome: failure(reply, { 409: 'SEATS_UNAVAILABLE', 404: 'SEATS_NOT_FOUND' }) }
      }

      case 'PROCESS_PAYMENT': {
        if (!order.total_amount) return { outcome: { type: 'rejected', reason: 'MISSING_TOTAL' } }
        // The order id is the idempotency key: a retry (e.g. after a timeout)
        // returns what happened the first time instead of charging again.
        const reply = await post(payment, paymentOf, { order_id: order.id, amount: order.total_amount })
        if (succeeded(reply, 200)) return ok
        return { outcome: failure(reply, { 402: 'PAYMENT_DECLINED', 422: 'AMOUNT_MISMATCH' }) }
      }

      case 'CONFIRM_SEATS': {
        const reply = await post(inventory, `${reservation}/confirm`, { seat_ids: order.seat_ids })
        if (succeeded(reply, 200)) return ok
        return { outcome: failure(reply, { 409: 'RESERVATION_LOST' }) }
      }

      case 'REFUND_PAYMENT': {
        // Idempotent on payment-service's side: "never charged" and "already
        // refunded" are both a 200. If a charge's outcome was unknown, it
        // asks the provider first, so a late charge can't slip past a refund.
        const reply = await post(payment, `${paymentOf}/${order.id}/refund`)
        if (succeeded(reply, 200)) return ok
        return { outcome: failure(reply, {}) }
      }

      case 'RELEASE_SEATS': {
        const reply = await post(inventory, `${reservation}/release`)
        if (succeeded(reply, 200)) return ok
        return { outcome: failure(reply, {}) }
      }

      case 'DONE':
        throw new Error(`order ${order.id} has no step to run`)
    }
  }

  return runStep
}

export type RunStep = ReturnType<typeof createStepRunner>
