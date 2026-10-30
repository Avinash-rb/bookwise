// Circuit breaker: stop calling a service that keeps failing, give it time to
// recover, then test it carefully. Like the breaker in your house's fuse box.
//
//   CLOSED ──(N failures in a row)──► OPEN ──(wait resetMs)──► HALF_OPEN
//     ▲                                ▲                          │
//     └──────── trial call works ──────┼────── trial call fails ──┘
//
// CLOSED:    normal; calls go through, consecutive failures are counted.
// OPEN:      calls are refused instantly (fail fast) instead of each one
//            waiting for a timeout, which also stops us piling load onto a
//            struggling service.
// HALF_OPEN: after resetMs, exactly one trial call is let through. Success
//            closes the circuit; failure opens it again.

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface BreakerOptions {
  failureThreshold?: number // consecutive failures that open the circuit
  resetMs?: number // how long to stay open before a trial call
  onStateChange?: (from: BreakerState, to: BreakerState) => void
  now?: () => number // injectable clock, for tests
}

export function createCircuitBreaker({
  failureThreshold = 5,
  resetMs = 10_000,
  onStateChange,
  now = Date.now,
}: BreakerOptions = {}) {
  let state: BreakerState = 'CLOSED'
  let failures = 0
  let openedAt = 0
  let trialInFlight = false

  const moveTo = (next: BreakerState) => {
    if (next === state) return
    const previous = state
    state = next
    onStateChange?.(previous, next)
  }

  return {
    get state() {
      return state
    },

    // Ask before every call. false = don't call, treat it as a failure now.
    allow(): boolean {
      if (state === 'CLOSED') return true
      if (state === 'OPEN' && now() - openedAt >= resetMs) {
        moveTo('HALF_OPEN')
        trialInFlight = true
        return true // the single trial call
      }
      return false // OPEN and still cooling down, or a trial is already running
    },

    success() {
      failures = 0
      trialInFlight = false
      moveTo('CLOSED')
    },

    failure() {
      failures++
      if (state === 'HALF_OPEN' || failures >= failureThreshold) {
        trialInFlight = false
        openedAt = now()
        moveTo('OPEN')
      }
    },

    // Exposed for tests / health output.
    get trialInFlight() {
      return trialInFlight
    },
  }
}

export type CircuitBreaker = ReturnType<typeof createCircuitBreaker>
