import { type Logger, type Pool, withTransaction } from '@bookwise/common'
import { backoffSeconds, decide, type StepOutcome, type Transition } from './decide'
import type { RunStep, SagaOrder, StepResult } from './steps'

export interface WorkerOptions {
  pollIntervalMs: number
  concurrency: number // max steps running at once in this process
  leaseSeconds: number // must be longer than one step's HTTP timeout
  maxAttempts: number
}

// Runs in every order-service replica. For each order:
//   1. CLAIM due orders (short transaction): FOR UPDATE SKIP LOCKED, so two
//      replicas never claim the same order, plus a lease (locked_until) and a
//      version bump.
//   2. RUN each order's current step: HTTP calls, OUTSIDE any transaction, so
//      no DB connection is held while waiting on the network.
//   3. SAVE the transition decide() returns, only if our claim is still the
//      latest (version unchanged). A worker whose lease expired is "fenced
//      out" and can't overwrite the newer worker's progress.
// If the process crashes between 1 and 3, the lease simply expires and another
// worker (or this one after a restart) runs the step again. That's safe
// because every step is idempotent.
export function createSagaWorker({
  pool,
  logger,
  runStep,
  options,
}: {
  pool: Pool
  logger: Logger
  runStep: RunStep
  options: WorkerOptions
}) {
  async function claimDue(limit: number): Promise<SagaOrder[]> {
    const { rows } = await pool.query<SagaOrder>(
      `UPDATE orders o
       SET locked_until = now() + make_interval(secs => $2), version = o.version + 1
       FROM (
         SELECT id FROM orders
         WHERE next_run_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY next_run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ) due
       WHERE o.id = due.id
       RETURNING o.id, o.saga_step AS step, o.attempts, o.version, o.show_id, o.total_amount,
         ARRAY(SELECT show_seat_id::text FROM order_seats WHERE order_id = o.id ORDER BY 1) AS seat_ids`,
      [limit, options.leaseSeconds],
    )
    return rows
  }

  const logAction = (outcome: StepOutcome, transition: Transition) => {
    if (outcome.type === 'ok') return 'COMPLETED'
    return transition.schedule === 'retry' ? 'RETRY' : 'FAILED'
  }

  // Saves the step's result and the next state. Returns false if fenced out.
  async function save(order: SagaOrder, result: StepResult, transition: Transition): Promise<boolean> {
    const delaySeconds =
      transition.schedule === 'now'
        ? 0
        : transition.schedule === 'retry'
          ? backoffSeconds(transition.attempts)
          : null
    const error = result.outcome.type === 'transient' ? result.outcome.error : null

    return withTransaction(pool, async (client) => {
      const updated = await client.query(
        `UPDATE orders
         SET saga_step = $3, status = $4, attempts = $5,
             next_run_at = CASE WHEN $6::float8 IS NULL THEN NULL
                                ELSE now() + make_interval(secs => $6::float8) END,
             locked_until = NULL,
             last_error = $7,
             failure_reason = COALESCE($8, failure_reason),
             total_amount = COALESCE($9::numeric, total_amount),
             updated_at = now()
         WHERE id = $1 AND version = $2`,
        [
          order.id,
          order.version,
          transition.step,
          transition.status,
          transition.attempts,
          delaySeconds,
          error,
          transition.failureReason ?? null,
          result.reservation?.total_amount ?? null,
        ],
      )
      if (updated.rowCount === 0) return false // someone else owns this order now

      if (result.reservation) {
        // Per-seat prices from inventory, for the receipt.
        await client.query(
          `UPDATE order_seats SET price = v.price
           FROM unnest($2::uuid[], $3::numeric[]) AS v(seat_id, price)
           WHERE order_seats.order_id = $1 AND order_seats.show_seat_id = v.seat_id`,
          [
            order.id,
            result.reservation.seats.map((s) => s.show_seat_id),
            result.reservation.seats.map((s) => s.price),
          ],
        )
      }

      await client.query(`INSERT INTO saga_logs (order_id, step, action, payload) VALUES ($1, $2, $3, $4)`, [
        order.id,
        order.step,
        logAction(result.outcome, transition),
        JSON.stringify({ outcome: result.outcome, next: transition.step, status: transition.status }),
      ])
      return true
    })
  }

  async function processOne(order: SagaOrder): Promise<Transition> {
    const log = logger.child({ orderId: order.id, step: order.step, attempt: order.attempts + 1 })
    let result: StepResult
    try {
      result = await runStep(order)
    } catch (err) {
      result = { outcome: { type: 'transient', error: err instanceof Error ? err.message : String(err) } }
    }

    const transition = decide(order.step, result.outcome, order.attempts, options.maxAttempts)
    const saved = await save(order, result, transition)
    if (!saved) {
      log.warn('lease lost: another worker took over this order, result discarded')
    } else if (transition.status === 'NEEDS_ATTENTION') {
      log.error({ outcome: result.outcome, reason: transition.failureReason }, 'saga needs attention')
    } else {
      log.info(
        { outcome: result.outcome.type, next: transition.step, status: transition.status },
        'saga step done',
      )
    }
    return transition
  }

  // ── The loop ───────────────────────────────────────────────────
  // The loop only HANDS OUT work: it claims as many due orders as there are
  // free slots and starts each one on its own. It never waits for a step to
  // finish, so one slow call (payment hanging until its timeout) can't hold up
  // other orders — no head-of-line blocking. `concurrency` caps how many steps
  // run at once in this process.
  const inFlight = new Set<Promise<unknown>>()
  let timer: NodeJS.Timeout | undefined
  let current: Promise<void> = Promise.resolve()
  let busy = false
  let wakeRequested = false
  let stopped = false

  function launch(order: SagaOrder) {
    const work = processOne(order)
      .then((transition) => {
        // The next step is due right away (e.g. reserve -> pay): don't wait for the poll.
        if (transition.schedule === 'now') wake()
      })
      .catch((err: unknown) => {
        // E.g. the DB failed while saving. The lease expires and the step is
        // retried later, so nothing is lost.
        logger.error({ err, orderId: order.id }, 'saga step crashed')
      })
      .finally(() => {
        inFlight.delete(work)
        wake() // a slot is free again
      })
    inFlight.add(work)
  }

  // Returns true if there's probably more due work than we had slots for.
  async function claimAndLaunch(): Promise<boolean> {
    const free = options.concurrency - inFlight.size
    if (free <= 0) return false
    const due = await claimDue(free)
    for (const order of due) launch(order)
    return due.length === free
  }

  const tick = async () => {
    busy = true
    let again = false
    try {
      again = await claimAndLaunch()
    } catch (err) {
      logger.error({ err }, 'saga worker loop failed')
    }
    busy = false
    again = again || wakeRequested
    wakeRequested = false
    if (!stopped) timer = setTimeout(run, again ? 0 : options.pollIntervalMs)
  }
  const run = () => {
    current = tick()
  }

  // Look for work now instead of at the next poll: after a new order is
  // committed, a step finished, or a slot freed up.
  function wake() {
    if (stopped) return
    if (busy) {
      wakeRequested = true
      return
    }
    clearTimeout(timer)
    run()
  }

  return {
    start: run,
    wake,
    // Graceful shutdown: claim nothing new; let running steps finish and save.
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await current
      await Promise.all(inFlight)
    },
  }
}

export type SagaWorker = ReturnType<typeof createSagaWorker>
