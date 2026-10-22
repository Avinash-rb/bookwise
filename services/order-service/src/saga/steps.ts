import { INTERNAL_TOKEN_HEADER } from '@bookwise/common'
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
}

// "Try again later" vs "no". 5xx / 408 / 429 are the other side's temporary
// trouble. 401/403 on a service-to-service call mean OUR credentials were
// refused — a deployment problem, not the customer's fault — so we retry
// (and end with a human) rather than tell the customer "seats unavailable".
export const isTransientStatus = (status: number) =>
  status >= 500 || status === 408 || status === 429 || status === 401 || status === 403

type Reply = { status: number; body: Record<string, unknown> } | { error: string }

export function createStepRunner({ inventoryUrl, paymentUrl, internalToken, timeoutMs }: StepDeps) {
  async function post(url: string, body: object = {}): Promise<Reply> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: internalToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const json: unknown = await res.json().catch(() => ({}))
      return {
        status: res.status,
        body: typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {},
      }
    } catch (err) {
      // Timeout, connection refused, DNS... we don't know if it was done.
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

    switch (order.step) {
      case 'RESERVE_SEATS': {
        const reply = await post(`${inventoryUrl}/internal/reservations`, {
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
        // The same idempotency key (the order id) on every retry: the payment
        // service returns the stored result instead of charging again.
        const reply = await post(`${paymentUrl}/payments`, {
          order_id: order.id,
          amount: Number(order.total_amount),
          idempotency_key: order.id,
        })
        if (succeeded(reply, 200, 201)) return ok
        return { outcome: failure(reply, { 402: 'PAYMENT_DECLINED' }) }
      }

      case 'CONFIRM_SEATS': {
        const reply = await post(`${reservation}/confirm`, { seat_ids: order.seat_ids })
        if (succeeded(reply, 200)) return ok
        return { outcome: failure(reply, { 409: 'RESERVATION_LOST' }) }
      }

      case 'REFUND_PAYMENT': {
        const reply = await post(`${paymentUrl}/payments/refund`, { order_id: order.id })
        // 404 = "no completed payment for this order": never charged, or
        // already refunded. Either way the goal (no money taken) is reached.
        if (succeeded(reply, 200, 404)) return ok
        return { outcome: failure(reply, {}) }
      }

      case 'RELEASE_SEATS': {
        const reply = await post(`${reservation}/release`)
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
