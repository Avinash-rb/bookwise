import { describe, expect, it } from 'vitest'
import { type BreakerState, createCircuitBreaker } from './breaker'

// A fake clock we move by hand, so the test doesn't wait 10 real seconds.
const setup = () => {
  let time = 0
  const changes: string[] = []
  const breaker = createCircuitBreaker({
    failureThreshold: 3,
    resetMs: 1000,
    now: () => time,
    onStateChange: (from: BreakerState, to: BreakerState) => changes.push(`${from}->${to}`),
  })
  return { breaker, changes, advance: (ms: number) => (time += ms) }
}

describe('circuit breaker', () => {
  it('stays CLOSED below the threshold; a success resets the count', () => {
    const { breaker } = setup()
    breaker.failure()
    breaker.failure()
    breaker.success()
    breaker.failure()
    breaker.failure()
    expect(breaker.state).toBe('CLOSED')
    expect(breaker.allow()).toBe(true)
  })

  it('opens after N consecutive failures and then refuses calls instantly', () => {
    const { breaker, changes } = setup()
    for (let i = 0; i < 3; i++) breaker.failure()
    expect(breaker.state).toBe('OPEN')
    expect(breaker.allow()).toBe(false)
    expect(changes).toEqual(['CLOSED->OPEN'])
  })

  it('after the cool-down, lets exactly ONE trial call through', () => {
    const { breaker, advance } = setup()
    for (let i = 0; i < 3; i++) breaker.failure()
    advance(999)
    expect(breaker.allow()).toBe(false) // still cooling down
    advance(1)
    expect(breaker.allow()).toBe(true) // the trial
    expect(breaker.state).toBe('HALF_OPEN')
    expect(breaker.allow()).toBe(false) // nobody else while the trial runs
  })

  it('closes when the trial succeeds', () => {
    const { breaker, advance, changes } = setup()
    for (let i = 0; i < 3; i++) breaker.failure()
    advance(1000)
    breaker.allow()
    breaker.success()
    expect(breaker.state).toBe('CLOSED')
    expect(changes).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED'])
  })

  it('re-opens (and restarts the cool-down) when the trial fails', () => {
    const { breaker, advance } = setup()
    for (let i = 0; i < 3; i++) breaker.failure()
    advance(1000)
    breaker.allow()
    breaker.failure()
    expect(breaker.state).toBe('OPEN')
    advance(500)
    expect(breaker.allow()).toBe(false)
    advance(500)
    expect(breaker.allow()).toBe(true)
  })
})
