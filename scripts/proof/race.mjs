// Proof 1: concurrency. 100 customers race for one seat (exactly one wins),
// then 50 orders lock the same two seats in opposite orders (no deadlock).
//
//   npm run up            # the whole stack must be running
//   npm run proof:race
import { runInNetwork, sql } from './docker.mjs'

const deadlocksBefore = Number(
  sql('inventory', 'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()'),
)

try {
  console.log(runInNetwork(new URL('./race.network.mjs', import.meta.url)))
} catch (err) {
  console.log(err.message)
  process.exitCode = 1
}

// Postgres counts every deadlock it had to break, per database.
const deadlocks =
  Number(sql('inventory', 'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')) -
  deadlocksBefore
console.log(`${deadlocks === 0 ? '✔' : '✘'} deadlocks detected by Postgres during the run: ${deadlocks}`)
if (deadlocks !== 0) process.exitCode = 1
