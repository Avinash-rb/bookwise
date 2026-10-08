// End-to-end demo through the gateway: a vendor sets up a show, a customer
// books seats, and the ownership rules hold.
//
//   npm run up                      # whole stack in Docker
//   node --env-file=.env scripts/demo.mjs
//
// Needs ADMIN_EMAIL / ADMIN_PASSWORD (the admin seeded by auth-service) because
// only admins add movies. GATEWAY_URL defaults to http://localhost:3000.

const BASE = process.env.GATEWAY_URL ?? 'http://localhost:3000'
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (e.g. run with --env-file=.env).')
  process.exit(1)
}

const run = Date.now().toString(36) // unique emails per run
let failures = 0

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

// Prints one step; stops the demo if the status isn't the expected one.
function step(label, res, expected, detail = '') {
  const ok = res.status === expected
  if (!ok) failures++
  console.log(`${ok ? '✔' : '✘'} ${label.padEnd(58)} ${res.status}${detail ? `  ${detail}` : ''}`)
  if (!ok) {
    console.log('   expected', expected, '→ got', JSON.stringify(res.json))
    process.exit(1)
  }
  return res.json
}

const register = (role, name) =>
  call('POST', '/api/auth/register', {
    body: { email: `${name}-${run}@demo.test`, password: 'demo-password-123', full_name: name, role },
  })

console.log(`BookWise demo — every request goes through the gateway (${BASE})\n`)

// ── Platform admin adds a movie ──
const admin = step(
  'Admin logs in',
  await call('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }),
  200,
)
const movie = step(
  'Admin adds a movie to the catalogue',
  await call('POST', '/api/admin/movies', {
    token: admin.access_token,
    body: { title: `Interstellar (${run})`, duration_mins: 169, genre: 'Sci-Fi' },
  }),
  201,
)

// ── Vendor A sets up a theatre, a screen and a show ──
const vendorA = step('Vendor A registers', await register('vendor', 'vendor-a'), 201)
const theatre = step(
  'Vendor A creates a theatre',
  await call('POST', '/api/vendor/theatres', {
    token: vendorA.access_token,
    body: { name: 'Demo Cinemas', city: 'Pune', address: 'FC Road' },
  }),
  201,
)
const screenRes = await call('POST', `/api/vendor/theatres/${theatre.id}/screens`, {
  token: vendorA.access_token,
  body: { name: 'Screen 1', rows: 3, seatsPerRow: 5 },
})
const screen = step(
  'Vendor A adds a screen (3 rows × 5 seats)',
  screenRes,
  201,
  `${screenRes.json?.seats_created} seats created`,
)
const show = step(
  'Vendor A schedules a show',
  await call('POST', '/api/vendor/shows', {
    token: vendorA.access_token,
    body: {
      movie_id: movie.id,
      screen_id: screen.screen.id,
      start_time: new Date(Date.now() + 86_400_000).toISOString(),
      price: 250,
    },
  }),
  201,
)

// ── Ownership: another vendor can't touch Vendor A's theatre ──
const vendorB = step('Vendor B registers', await register('vendor', 'vendor-b'), 201)
step(
  "Vendor B tries to add a screen to Vendor A's theatre",
  await call('POST', `/api/vendor/theatres/${theatre.id}/screens`, {
    token: vendorB.access_token,
    body: { name: 'Hijacked', rows: 1, seatsPerRow: 1 },
  }),
  403,
  'blocked by inventory-service',
)
const mine = step(
  'Vendor B lists "my theatres"',
  await call('GET', '/api/vendor/theatres', { token: vendorB.access_token }),
  200,
)
console.log(`  → Vendor B sees ${mine.length} theatre(s)`)

// ── A customer browses and books ──
const customer = step('Customer registers', await register('customer', 'customer'), 201)
const seatMap = step(
  'Customer opens the seat map (public)',
  await call('GET', `/api/shows/${show.id}/seats`),
  200,
)
console.log(`  → ${seatMap.available} of ${seatMap.total} seats available`)

const seats = seatMap.seats_by_row.A.slice(0, 2).map((s) => s.show_seat_id)
step(
  'Customer tries to create a show',
  await call('POST', '/api/vendor/shows', { token: customer.access_token, body: {} }),
  403,
  'blocked by the gateway',
)
const order = step(
  'Customer books seats A1 + A2',
  await call('POST', '/api/orders', {
    token: customer.access_token,
    body: { show_id: show.id, seat_ids: seats, total_amount: 500 },
  }),
  201,
)
console.log(`  → order ${order.status}: ${order.message} (payments are randomly declined 10% of the time)`)

// ── Ownership: orders are private ──
const own = step(
  'Customer views their own order',
  await call('GET', `/api/orders/${order.order_id}`, { token: customer.access_token }),
  200,
)
console.log(`  → booked for ${own.customer_email}`)
const other = step('A second customer registers', await register('customer', 'other'), 201)
step(
  "Second customer tries to view the first customer's order",
  await call('GET', `/api/orders/${order.order_id}`, { token: other.access_token }),
  404,
  'looks like it does not exist',
)

console.log(failures === 0 ? '\nAll steps behaved as expected.' : `\n${failures} step(s) failed.`)
