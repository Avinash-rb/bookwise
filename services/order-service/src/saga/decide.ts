// The booking saga as a pure state machine: (current step, what happened) ->
// what to do next. No database, no network, no clock, no randomness, so every
// path can be unit-tested as a table.
//
//   RESERVE_SEATS ──► PROCESS_PAYMENT ──► CONFIRM_SEATS ──► DONE (CONFIRMED)
//        │                  │                   │
//        │ seats taken      │ declined          │ reservation lost
//        ▼                  ▼                   ▼
//   DONE (FAILED)     RELEASE_SEATS ◄──── REFUND_PAYMENT
//                           │
//                           ▼
//                     DONE (FAILED)

export type SagaStep =
  | 'RESERVE_SEATS'
  | 'PROCESS_PAYMENT'
  | 'CONFIRM_SEATS'
  | 'REFUND_PAYMENT'
  | 'RELEASE_SEATS'
  | 'DONE'

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'NEEDS_ATTENTION'

// What happened when a step ran.
export type StepOutcome =
  | { type: 'ok' } // it worked (or had already been done)
  | { type: 'rejected'; reason: string } // a definite business "no": don't retry
  | { type: 'transient'; error: string } // timeout, 5xx, network: worth retrying

export interface Transition {
  step: SagaStep
  status: OrderStatus
  attempts: number // attempts of the (new) current step so far
  // When to run `step`: right away, after a backoff delay, or never (finished
  // or waiting for a human).
  schedule: 'now' | 'retry' | 'none'
  failureReason?: string // set when the booking starts failing; kept afterwards
}

const next = (step: SagaStep, failureReason?: string): Transition => ({
  step,
  status: 'PENDING',
  attempts: 0,
  schedule: 'now',
  ...(failureReason ? { failureReason } : {}),
})
const finished = (status: 'CONFIRMED' | 'FAILED', failureReason?: string): Transition => ({
  step: 'DONE',
  status,
  attempts: 0,
  schedule: 'none',
  ...(failureReason ? { failureReason } : {}),
})
// Stop and wait for a human: guessing could refund a real booking or keep
// money for seats we don't have.
const needsAttention = (step: SagaStep, attempts: number, failureReason: string): Transition => ({
  step,
  status: 'NEEDS_ATTENTION',
  attempts,
  schedule: 'none',
  failureReason,
})

export function decide(
  step: SagaStep,
  outcome: StepOutcome,
  attempts: number, // failed attempts of this step BEFORE this one
  maxAttempts: number,
): Transition {
  if (step === 'DONE') throw new Error('decide() called for a finished saga')

  // A temporary error with tries left: run the same step again, later.
  const tried = attempts + 1
  if (outcome.type === 'transient' && tried < maxAttempts) {
    return { step, status: 'PENDING', attempts: tried, schedule: 'retry' }
  }
  const exhausted = outcome.type === 'transient' // ...and no tries left

  switch (step) {
    // Compensatable: nothing irreversible has happened yet.
    case 'RESERVE_SEATS':
      if (outcome.type === 'ok') return next('PROCESS_PAYMENT')
      // Reserve is all-or-nothing, so a "no" means nothing is held.
      if (outcome.type === 'rejected') return finished('FAILED', outcome.reason)
      // Gave up, but a timed-out reserve may have worked: free anything held.
      return next('RELEASE_SEATS', 'INVENTORY_UNAVAILABLE')

    // The pivot: once it succeeds, the booking must go forward.
    case 'PROCESS_PAYMENT':
      if (outcome.type === 'ok') return next('CONFIRM_SEATS')
      if (outcome.type === 'rejected') return next('RELEASE_SEATS', outcome.reason)
      // Gave up: we might have been charged, so refund (a no-op if not).
      return next('REFUND_PAYMENT', 'PAYMENT_UNAVAILABLE')

    // Retriable: after payment, a timeout is NOT a reason to undo. Only a
    // definite "your hold is gone" is.
    case 'CONFIRM_SEATS':
      if (outcome.type === 'ok') return finished('CONFIRMED')
      if (outcome.type === 'rejected') return next('REFUND_PAYMENT', outcome.reason)
      return needsAttention(step, tried, 'CONFIRM_STUCK')

    // Compensations must eventually succeed; if they can't, a human steps in.
    case 'REFUND_PAYMENT':
      if (outcome.type === 'ok') return next('RELEASE_SEATS')
      return needsAttention(step, tried, exhausted ? 'REFUND_STUCK' : 'REFUND_REJECTED')

    case 'RELEASE_SEATS':
      if (outcome.type === 'ok') return finished('FAILED')
      return needsAttention(step, tried, exhausted ? 'RELEASE_STUCK' : 'RELEASE_REJECTED')
  }
}

// Exponential backoff with "full jitter": wait a random time between 0 and
// base * 2^attempt (capped). Without the randomness, 1,000 orders that failed
// together would all retry in the same millisecond and fail together again.
export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30, 0.5 * 2 ** attempt)
  return ceiling * random()
}
