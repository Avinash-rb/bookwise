import { describe, expect, it } from 'vitest'
import { backoffSeconds, decide, type SagaStep, type StepOutcome } from './decide'

const MAX = 5
const ok: StepOutcome = { type: 'ok' }
const no = (reason: string): StepOutcome => ({ type: 'rejected', reason })
const timeout: StepOutcome = { type: 'transient', error: 'timeout' }

// The step after the last allowed attempt failed with a temporary error.
const exhausted = (step: SagaStep) => decide(step, timeout, MAX - 1, MAX)

describe('happy path', () => {
  it('reserve -> pay -> confirm -> CONFIRMED', () => {
    expect(decide('RESERVE_SEATS', ok, 0, MAX)).toMatchObject({ step: 'PROCESS_PAYMENT', schedule: 'now' })
    expect(decide('PROCESS_PAYMENT', ok, 0, MAX)).toMatchObject({ step: 'CONFIRM_SEATS', schedule: 'now' })
    expect(decide('CONFIRM_SEATS', ok, 0, MAX)).toEqual({
      step: 'DONE',
      status: 'CONFIRMED',
      attempts: 0,
      schedule: 'none',
    })
  })
})

describe('business failures (a definite "no")', () => {
  it('seats taken: fail straight away, nothing to undo', () => {
    expect(decide('RESERVE_SEATS', no('SEATS_UNAVAILABLE'), 0, MAX)).toMatchObject({
      step: 'DONE',
      status: 'FAILED',
      failureReason: 'SEATS_UNAVAILABLE',
    })
  })

  it('payment declined: release the seats (no refund needed)', () => {
    expect(decide('PROCESS_PAYMENT', no('PAYMENT_DECLINED'), 0, MAX)).toMatchObject({
      step: 'RELEASE_SEATS',
      status: 'PENDING',
      failureReason: 'PAYMENT_DECLINED',
    })
  })

  it('reservation lost after paying: refund, then release', () => {
    expect(decide('CONFIRM_SEATS', no('RESERVATION_LOST'), 0, MAX)).toMatchObject({
      step: 'REFUND_PAYMENT',
      failureReason: 'RESERVATION_LOST',
    })
    expect(decide('REFUND_PAYMENT', ok, 0, MAX)).toMatchObject({ step: 'RELEASE_SEATS' })
    expect(decide('RELEASE_SEATS', ok, 0, MAX)).toMatchObject({ step: 'DONE', status: 'FAILED' })
  })
})

describe('temporary failures', () => {
  it('retries the same step later while attempts remain, counting them', () => {
    expect(decide('RESERVE_SEATS', timeout, 0, MAX)).toEqual({
      step: 'RESERVE_SEATS',
      status: 'PENDING',
      attempts: 1,
      schedule: 'retry',
    })
    expect(decide('CONFIRM_SEATS', timeout, 3, MAX)).toMatchObject({ attempts: 4, schedule: 'retry' })
  })

  it('a successful retry resets the attempt counter for the next step', () => {
    expect(decide('RESERVE_SEATS', ok, 3, MAX)).toMatchObject({ step: 'PROCESS_PAYMENT', attempts: 0 })
  })

  it('reserve out of retries: release (a timed-out reserve may have worked)', () => {
    expect(exhausted('RESERVE_SEATS')).toMatchObject({
      step: 'RELEASE_SEATS',
      failureReason: 'INVENTORY_UNAVAILABLE',
    })
  })

  it('payment out of retries: refund (we may have been charged), then release', () => {
    expect(exhausted('PROCESS_PAYMENT')).toMatchObject({
      step: 'REFUND_PAYMENT',
      failureReason: 'PAYMENT_UNAVAILABLE',
    })
  })

  it('confirm out of retries AFTER paying: never undo on a guess, ask a human', () => {
    expect(exhausted('CONFIRM_SEATS')).toEqual({
      step: 'CONFIRM_SEATS',
      status: 'NEEDS_ATTENTION',
      attempts: MAX,
      schedule: 'none',
      failureReason: 'CONFIRM_STUCK',
    })
  })

  it('compensations that cannot finish also go to a human', () => {
    expect(exhausted('REFUND_PAYMENT')).toMatchObject({
      status: 'NEEDS_ATTENTION',
      failureReason: 'REFUND_STUCK',
    })
    expect(exhausted('RELEASE_SEATS')).toMatchObject({
      status: 'NEEDS_ATTENTION',
      failureReason: 'RELEASE_STUCK',
    })
    expect(decide('RELEASE_SEATS', no('BAD_REQUEST'), 0, MAX)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      failureReason: 'RELEASE_REJECTED',
    })
  })
})

it('refuses to run a finished saga', () => {
  expect(() => decide('DONE', ok, 0, MAX)).toThrow()
})

describe('backoffSeconds (exponential + full jitter)', () => {
  it('doubles the ceiling each attempt, capped at 30 s', () => {
    const max = () => 1 // worst case of the random factor
    expect([0, 1, 2, 3, 4, 10].map((a) => backoffSeconds(a, max))).toEqual([0.5, 1, 2, 4, 8, 30])
  })

  it('spreads retries randomly below the ceiling', () => {
    expect(backoffSeconds(3, () => 0.25)).toBe(1)
    expect(backoffSeconds(3, () => 0)).toBe(0)
  })
})
