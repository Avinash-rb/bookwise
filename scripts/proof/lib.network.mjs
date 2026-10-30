// Shared helpers for scripts that run INSIDE the Docker network.
// (Biome: unused-variable warnings are off for this file, because its helpers are
// used by the scripts it gets prepended to.)
// docker.mjs prepends this file to each *.network.mjs script before running it
// in the order-service container, so those scripts can use everything here.

const INVENTORY = 'http://inventory-service:3002'
const ORDERS = 'http://127.0.0.1:3001'
const newId = () => crypto.randomUUID()
const as = (role, id = newId()) => ({
  'x-user-id': id,
  'x-user-role': role,
  'x-user-email': `${role}-${id.slice(0, 8)}@proof.test`,
})
let failed = false
const check = (ok, text) => {
  if (!ok) failed = true
  console.log(`${ok ? '✔' : '✘'} ${text}`)
}

async function call(base, method, path, headers, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

// A show on a fresh 1 x 6 screen; returns its seat ids in order.
async function createShow() {
  const vendor = as('vendor')
  const movie = await call(INVENTORY, 'POST', '/admin/movies', as('admin'), {
    title: 'Proof',
    duration_mins: 90,
  })
  const theatre = await call(INVENTORY, 'POST', '/vendor/theatres', vendor, {
    name: 'Proof Cinema',
    city: 'Pune',
    address: 'Test Road',
  })
  const screen = await call(INVENTORY, 'POST', `/vendor/theatres/${theatre.id}/screens`, vendor, {
    name: 'S1',
    rows: 1,
    seatsPerRow: 6,
  })
  const show = await call(INVENTORY, 'POST', '/vendor/shows', vendor, {
    movie_id: movie.id,
    screen_id: screen.screen.id,
    start_time: new Date(Date.now() + 86_400_000).toISOString(),
    price: 200,
  })
  const map = await call(INVENTORY, 'GET', `/shows/${show.id}/seats`, {})
  return { showId: show.id, seats: map.seats_by_row.A.map((s) => s.show_seat_id) }
}

const seatStatus = async (showId, seatId) =>
  (await call(INVENTORY, 'GET', `/shows/${showId}/seats`, {})).seats_by_row.A.find(
    (s) => s.show_seat_id === seatId,
  ).status

// Places all bookings at the same moment, then polls until none is PENDING.
async function race(showId, seatSetFor, count) {
  const customers = Array.from({ length: count }, () => as('customer'))
  const started = Date.now()
  const placed = await Promise.all(
    customers.map((headers, i) =>
      call(ORDERS, 'POST', '/orders', headers, { show_id: showId, seat_ids: seatSetFor(i) }),
    ),
  )
  let orders = placed.map((p, i) => ({ id: p.order_id, headers: customers[i], status: 'PENDING' }))
  while (orders.some((o) => o.status === 'PENDING') && Date.now() - started < 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    orders = await Promise.all(
      orders.map(async (o) =>
        o.status === 'PENDING' ? { ...o, ...(await call(ORDERS, 'GET', `/orders/${o.id}`, o.headers)) } : o,
      ),
    )
  }
  const tally = {}
  for (const o of orders) {
    const key = o.failure_reason ? `${o.status} (${o.failure_reason})` : o.status
    tally[key] = (tally[key] ?? 0) + 1
  }
  return { orders, tally, seconds: ((Date.now() - started) / 1000).toFixed(1) }
}
