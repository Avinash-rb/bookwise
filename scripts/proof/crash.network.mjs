// Runs INSIDE the Docker network (started by crash.mjs), with the helpers from
// lib.network.mjs prepended. Creates a show and places 3 bookings, then prints
// their ids as JSON for crash.mjs to follow.

const show = await createShow()
const ids = []
for (const seat of show.seats.slice(0, 3)) {
  const placed = await call(ORDERS, 'POST', '/orders', as('customer'), {
    show_id: show.showId,
    seat_ids: [seat],
  })
  ids.push(placed.order_id)
}
console.log(JSON.stringify(ids))
