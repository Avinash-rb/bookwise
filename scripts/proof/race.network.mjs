// Runs INSIDE the Docker network (started by race.mjs), with the helpers from
// lib.network.mjs prepended: call(), as(), createShow(), race(), check()...

// ── Race 1: 100 customers, 1 seat ─────────────────────────────
console.log('Race 1: 100 customers try to book the SAME seat at the same moment\n')
const show1 = await createShow()
const r1 = await race(show1.showId, () => [show1.seats[0]], 100)
console.table(r1.tally)
console.log(`all 100 finished in ${r1.seconds} s`)

// Exactly one order may get past "reserve". It then ends CONFIRMED, or
// FAILED (PAYMENT_DECLINED) if the simulated card is declined.
const winners1 = r1.orders.filter((o) => o.failure_reason !== 'SEATS_UNAVAILABLE')
check(winners1.length === 1, `exactly one order got the seat (${winners1.length})`)
check(
  r1.orders.every((o) => o.status !== 'PENDING'),
  'no order left PENDING',
)
const finalSeat1 = await seatStatus(show1.showId, show1.seats[0])
const expected1 = winners1[0]?.status === 'CONFIRMED' ? 'BOOKED' : 'AVAILABLE'
check(
  finalSeat1 === expected1,
  `seat ends ${finalSeat1}, consistent with the winner's ${winners1[0]?.status}`,
)

// ── Race 2: opposite lock order ───────────────────────────────
console.log('\nRace 2: 50 customers want seats {A2, A3}; half ask for [A2, A3], half for [A3, A2]\n')
const show2 = await createShow()
const [a2, a3] = [show2.seats[1], show2.seats[2]]
const r2 = await race(show2.showId, (i) => (i % 2 ? [a2, a3] : [a3, a2]), 50)
console.table(r2.tally)
console.log(`all 50 finished in ${r2.seconds} s`)
const winners2 = r2.orders.filter((o) => o.failure_reason !== 'SEATS_UNAVAILABLE')
check(winners2.length === 1, `exactly one order got both seats (${winners2.length})`)
check(
  !Object.keys(r2.tally).some((k) => k.includes('INVENTORY_UNAVAILABLE')),
  'no order failed because inventory errored (a deadlock would show up as one)',
)

process.exitCode = failed ? 1 : 0
