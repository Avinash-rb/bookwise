import { randomUUID } from 'node:crypto'
import type { Pool } from '@bookwise/common'

export interface ProviderCharge {
  outcome: 'SUCCEEDED' | 'DECLINED'
  reference: string
}

// A fake payment provider, standing in for Stripe/Razorpay. Two settings make
// demos realistic: how often cards are declined, and how slow the provider is.
//
// The property that matters: it is IDEMPOTENT by key, like real providers.
// The first call for a key decides and stores the outcome; every later call
// with the same key gets the same answer and money moves at most once. That's
// what lets us safely ask again after a timeout: "charge order X" a second
// time returns what happened the first time.
export function createFakeProvider({
  pool,
  declineRate,
  latencyMs,
}: {
  pool: Pool
  declineRate: number
  latencyMs: number
}) {
  const slow = () => new Promise((resolve) => setTimeout(resolve, latencyMs))

  async function charge(key: string, amount: string): Promise<ProviderCharge> {
    await slow()
    const outcome = Math.random() < declineRate ? 'DECLINED' : 'SUCCEEDED'
    await pool.query(
      `INSERT INTO provider_charges (idempotency_key, amount, outcome, reference)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, amount, outcome, `PSP_${randomUUID().slice(0, 8)}`],
    )
    // Whatever was stored first wins, whether by this call or an earlier one.
    const { rows } = await pool.query<ProviderCharge>(
      'SELECT outcome, reference FROM provider_charges WHERE idempotency_key = $1',
      [key],
    )
    return rows[0] as ProviderCharge
  }

  // Idempotent too: refunding twice refunds once.
  async function refund(key: string): Promise<void> {
    await slow()
    await pool.query(
      `UPDATE provider_charges SET refunded_at = now()
       WHERE idempotency_key = $1 AND outcome = 'SUCCEEDED' AND refunded_at IS NULL`,
      [key],
    )
  }

  return { charge, refund }
}

export type PaymentProvider = ReturnType<typeof createFakeProvider>
