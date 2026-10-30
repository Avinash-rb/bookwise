import { AppError, type Pool } from '@bookwise/common'
import type { PaymentProvider } from './provider'

export interface Payment {
  order_id: string
  amount: string // decimal string, e.g. "500.00"
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED'
  provider_reference: string | null
}

const COLUMNS = 'order_id, amount, status, provider_reference'

const amountMismatch = () =>
  new AppError(422, 'AMOUNT_MISMATCH', 'This order was already charged a different amount')

// One payment per order; the order id is the idempotency key everywhere.
//
//   charge:  INSERT PENDING (ON CONFLICT DO NOTHING) -> provider.charge(key) -> COMPLETED / FAILED
//
// The PENDING row is written BEFORE money moves. If we crash or time out after
// that, the row says "we started, outcome unknown". Nobody guesses: the next
// charge or refund call asks the provider again with the same key, and the
// provider (idempotent) tells us what really happened.
export function createPayments({ pool, provider }: { pool: Pool; provider: PaymentProvider }) {
  async function get(orderId: string): Promise<Payment | undefined> {
    const { rows } = await pool.query<Payment>(`SELECT ${COLUMNS} FROM payments WHERE order_id = $1`, [
      orderId,
    ])
    return rows[0]
  }

  // Finds out from the provider what happened for this key and records it.
  // Safe to run twice at once: same key -> same answer, and only the first
  // UPDATE matches `status = 'PENDING'`.
  async function settle(orderId: string, amount: string): Promise<Payment> {
    const result = await provider.charge(orderId, amount)
    await pool.query(
      `UPDATE payments SET status = $2, provider_reference = $3, updated_at = now()
       WHERE order_id = $1 AND status = 'PENDING'`,
      [orderId, result.outcome === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED', result.reference],
    )
    return (await get(orderId)) as Payment
  }

  async function charge(orderId: string, amount: string): Promise<Payment> {
    // Two identical requests at the same instant: the UNIQUE(order_id) lets
    // exactly one INSERT through. No "check, then insert" race.
    await pool.query(
      `INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, 'PENDING')
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, amount],
    )
    const { rows } = await pool.query<Payment & { same_amount: boolean }>(
      `SELECT ${COLUMNS}, amount = $2::numeric AS same_amount FROM payments WHERE order_id = $1`,
      [orderId, amount],
    )
    const { same_amount, ...payment } = rows[0] as Payment & { same_amount: boolean }

    // Same key, different request: a bug somewhere. Refuse rather than guess.
    if (!same_amount) throw amountMismatch()
    // Already decided: return the stored result. Nobody is charged twice.
    if (payment.status !== 'PENDING') return payment
    // New, or an earlier attempt that never finished: ask the provider.
    return settle(orderId, payment.amount)
  }

  // Compensation. Idempotent: refunding twice, or refunding an order that was
  // never charged, is a success with nothing to do.
  async function refund(orderId: string) {
    let payment = await get(orderId)
    if (!payment) return { order_id: orderId, refunded: false, status: 'NO_PAYMENT' }

    // Outcome unknown (a charge was cut off): find out before refunding, so a
    // charge can't land after we've decided there was nothing to refund.
    if (payment.status === 'PENDING') payment = await settle(orderId, payment.amount)

    if (payment.status === 'COMPLETED') {
      await provider.refund(orderId)
      await pool.query(
        `UPDATE payments SET status = 'REFUNDED', updated_at = now()
         WHERE order_id = $1 AND status = 'COMPLETED'`,
        [orderId],
      )
      payment = (await get(orderId)) as Payment
    }
    return { order_id: orderId, refunded: payment.status === 'REFUNDED', status: payment.status }
  }

  return { get, charge, refund }
}

export type Payments = ReturnType<typeof createPayments>
