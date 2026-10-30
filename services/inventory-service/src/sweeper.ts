import type { Logger } from '@bookwise/common'
import type { Reservations } from './reservations'

// Runs sweepExpired on a timer. setTimeout after each run (not setInterval),
// so a slow sweep can never overlap the next one.
export function startSweeper({
  reservations,
  logger,
  intervalMs,
}: {
  reservations: Reservations
  logger: Logger
  intervalMs: number
}) {
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> = Promise.resolve()
  let stopped = false

  const tick = async () => {
    try {
      const { seats, orders } = await reservations.sweepExpired()
      if (seats > 0) logger.info({ seats, orders }, 'expired seat holds released')
    } catch (err) {
      logger.error({ err }, 'reservation sweep failed')
    }
    if (!stopped) timer = setTimeout(schedule, intervalMs)
  }
  const schedule = () => {
    running = tick()
  }

  timer = setTimeout(schedule, intervalMs)

  return {
    // Graceful shutdown: no new sweeps, and wait for one in progress.
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await running
    },
  }
}
