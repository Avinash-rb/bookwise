// ─────────────────────────────────────────────────────────────
// BookWise Saga Orchestrator
//
// This is the HEART of the entire project.
//
// Flow:
//   1. Reserve Seats   → Inventory Service
//   2. Process Payment  → Payment Service
//   3. Confirm Seats    → Inventory Service
//
// Compensation (on failure):
//   - Payment failed? → Release seats
//   - Confirm failed? → Refund payment + Release seats
// ─────────────────────────────────────────────────────────────

import pool from '../db/client'

const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:3002'
const PAYMENT_URL   = process.env.PAYMENT_SERVICE_URL   || 'http://localhost:3003'

// Helper: update order status + log saga step
async function updateOrderStatus(
  orderId: string,
  status: string,
  step: string,
  action: string,
  payload: object = {}
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, orderId]
    )
    await client.query(
      `INSERT INTO saga_logs (order_id, step, action, payload)
       VALUES ($1, $2, $3, $4)`,
      [orderId, step, action, JSON.stringify(payload)]
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN SAGA EXECUTION
// ═══════════════════════════════════════════════════════════════
export async function executeSaga(
  orderId: string,
  showId: string,
  seatIds: string[],
  totalAmount: number
): Promise<{ success: boolean; status: string; message: string }> {

  console.log(`🎬 Saga started for order ${orderId}`)

  // ── STEP 1: Reserve Seats ─────────────────────────────────
  try {
    await updateOrderStatus(orderId, 'PENDING', 'RESERVE_SEATS', 'STARTED')

    const reserveRes = await fetch(`${INVENTORY_URL}/shows/${showId}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_ids: seatIds, order_id: orderId })
    })

    if (!reserveRes.ok) {
      const error = await reserveRes.json()
      await updateOrderStatus(orderId, 'FAILED', 'RESERVE_SEATS', 'FAILED', error)
      console.log(`❌ Saga FAILED at Step 1: ${JSON.stringify(error)}`)
      return { success: false, status: 'FAILED', message: `Seat reservation failed: ${error.error}` }
    }

    await updateOrderStatus(orderId, 'SEATS_RESERVED', 'RESERVE_SEATS', 'COMPLETED')
    console.log(`✅ Step 1: Seats reserved`)

  } catch (err: any) {
    await updateOrderStatus(orderId, 'FAILED', 'RESERVE_SEATS', 'FAILED', { error: err.message })
    return { success: false, status: 'FAILED', message: `Seat reservation error: ${err.message}` }
  }

  // ── STEP 2: Process Payment ───────────────────────────────
  try {
    await updateOrderStatus(orderId, 'SEATS_RESERVED', 'PROCESS_PAYMENT', 'STARTED')

    const paymentRes = await fetch(`${PAYMENT_URL}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: orderId,
        amount: totalAmount,
        idempotency_key: orderId    // ← same as order_id for idempotency
      })
    })

    const paymentData = await paymentRes.json()

    if (!paymentRes.ok || paymentData.status === 'FAILED') {
      // ── COMPENSATION 1: Release seats ──
      console.log(`⚠️ Payment failed — compensating: releasing seats`)
      await compensateReleaseSeats(orderId, showId)

      await updateOrderStatus(orderId, 'FAILED', 'PROCESS_PAYMENT', 'FAILED', paymentData)
      console.log(`❌ Saga FAILED at Step 2 (payment). Seats released.`)
      return { success: false, status: 'FAILED', message: 'Payment failed. Seats released.' }
    }

    await updateOrderStatus(orderId, 'PAYMENT_COMPLETED', 'PROCESS_PAYMENT', 'COMPLETED', paymentData)
    console.log(`✅ Step 2: Payment processed (${paymentData.provider_reference})`)

  } catch (err: any) {
    // Payment call failed entirely — compensate
    await compensateReleaseSeats(orderId, showId)
    await updateOrderStatus(orderId, 'FAILED', 'PROCESS_PAYMENT', 'FAILED', { error: err.message })
    return { success: false, status: 'FAILED', message: `Payment error: ${err.message}` }
  }

  // ── STEP 3: Confirm Seats ─────────────────────────────────
  try {
    await updateOrderStatus(orderId, 'PAYMENT_COMPLETED', 'CONFIRM_SEATS', 'STARTED')

    const confirmRes = await fetch(`${INVENTORY_URL}/shows/${showId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId })
    })

    if (!confirmRes.ok) {
      const error = await confirmRes.json()
      // ── COMPENSATION 2: Refund payment + Release seats ──
      console.log(`⚠️ Confirm failed — compensating: refund + release`)
      await compensateRefundPayment(orderId)
      await compensateReleaseSeats(orderId, showId)

      await updateOrderStatus(orderId, 'FAILED', 'CONFIRM_SEATS', 'FAILED', error)
      return { success: false, status: 'FAILED', message: 'Seat confirmation failed. Refunded.' }
    }

    await updateOrderStatus(orderId, 'CONFIRMED', 'CONFIRM_SEATS', 'COMPLETED')
    console.log(`🎉 Saga COMPLETED — Order ${orderId} CONFIRMED!`)
    return { success: true, status: 'CONFIRMED', message: 'Booking confirmed!' }

  } catch (err: any) {
    await compensateRefundPayment(orderId)
    await compensateReleaseSeats(orderId, showId)
    await updateOrderStatus(orderId, 'FAILED', 'CONFIRM_SEATS', 'FAILED', { error: err.message })
    return { success: false, status: 'FAILED', message: `Confirm error: ${err.message}` }
  }
}

// ═══════════════════════════════════════════════════════════════
// COMPENSATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function compensateReleaseSeats(orderId: string, showId: string) {
  try {
    await fetch(`${INVENTORY_URL}/shows/${showId}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId })
    })
    await updateOrderStatus(orderId, 'FAILED', 'RELEASE_SEATS', 'COMPENSATED')
    console.log(`  ↩ Compensation: Seats released for order ${orderId}`)
  } catch (err: any) {
    console.error(`  ❌ Compensation FAILED: Could not release seats`, err.message)
  }
}

async function compensateRefundPayment(orderId: string) {
  try {
    await fetch(`${PAYMENT_URL}/payments/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId })
    })
    await updateOrderStatus(orderId, 'FAILED', 'REFUND_PAYMENT', 'COMPENSATED')
    console.log(`  ↩ Compensation: Payment refunded for order ${orderId}`)
  } catch (err: any) {
    console.error(`  ❌ Compensation FAILED: Could not refund payment`, err.message)
  }
}
