// Proof 2: durability. Kill order-service in the middle of bookings and show
// that, after a restart, every booking finishes by itself.
//
//   npm run up            # the whole stack must be running
//   npm run proof:crash
//
// To catch bookings mid-flight, payment-service is stopped first: the saga
// gets stuck at the payment step (retrying), and that's when we pull the plug.
import { docker, runInNetwork, sleep, sql, waitHealthy } from './docker.mjs'

const ORDER = 'bookwise-order-service-1'
const PAYMENT = 'bookwise-payment-service-1'
const state = (ids) =>
  sql(
    'order',
    `SELECT left(id::text, 8) || '  ' || rpad(status, 16) || rpad(saga_step, 16) || 'attempts=' || attempts
     FROM orders WHERE id IN (${ids.map((id) => `'${id}'`).join(',')}) ORDER BY id`,
  )

console.log('1. Stop payment-service, so bookings get stuck at the payment step')
docker('stop', PAYMENT)

console.log('2. Place 3 bookings')
const ids = JSON.parse(
  runInNetwork(new URL('./crash.network.mjs', import.meta.url))
    .split('\n')
    .at(-1),
)
await sleep(2000)
console.log(state(ids))

console.log('\n3. 💥 Kill order-service (SIGKILL: no graceful shutdown, steps cut off mid-call)')
docker('kill', ORDER)

console.log('4. Start payment-service again, then order-service')
docker('start', PAYMENT)
docker('start', ORDER)
await waitHealthy(ORDER)

console.log('5. Wait for the saga to resume (claims held by the dead process expire after their 30 s lease)')
const started = Date.now()
let pending = ids.length
while (pending > 0 && Date.now() - started < 120_000) {
  await sleep(2000)
  pending = Number(
    sql(
      'order',
      `SELECT count(*) FROM orders WHERE status = 'PENDING' AND id IN (${ids.map((id) => `'${id}'`).join(',')})`,
    ),
  )
}
console.log(state(ids))
console.log(`   finished ${((Date.now() - started) / 1000).toFixed(0)} s after restart\n`)

console.log('Saga log of the first booking:')
console.log(
  sql(
    'order',
    `SELECT to_char(created_at, 'HH24:MI:SS') || '  ' || rpad(step, 16) || action
     FROM saga_logs WHERE order_id = '${ids[0]}' ORDER BY created_at`,
  ),
)

const paymentsPerOrder = sql(
  'payment',
  `SELECT coalesce(max(n), 0) FROM (SELECT count(*) AS n FROM payments WHERE order_id IN (${ids.map((id) => `'${id}'`).join(',')}) GROUP BY order_id) t`,
)
console.log()
console.log(
  `${pending === 0 ? '✔' : '✘'} every booking finished after the crash (${ids.length - pending}/${ids.length})`,
)
console.log(
  `${Number(paymentsPerOrder) <= 1 ? '✔' : '✘'} at most one payment per order (max ${paymentsPerOrder})`,
)
process.exitCode = pending === 0 && Number(paymentsPerOrder) <= 1 ? 0 : 1
