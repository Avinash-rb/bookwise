import { forbidden, getCaller, notFound, type Pool, roleGuard, withTransaction } from '@bookwise/common'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { assertOwnsScreen, assertOwnsTheatre } from '../ownership'
import { CreateScreenBody, CreateShowBody, CreateTheatreBody, IdParams } from '../schemas'

// Everything a theatre owner manages, under /vendor. One hook guards the whole
// group: a route added here later can't forget the role check.
const vendorRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (app, { pool }) => {
  app.addHook('onRequest', roleGuard('vendor', 'admin'))

  // GET /vendor/theatres — my theatres (an admin sees all)
  app.get('/theatres', async (request) => {
    const caller = getCaller(request)
    const result =
      caller.role === 'admin'
        ? await pool.query('SELECT * FROM theatres ORDER BY city, name')
        : await pool.query('SELECT * FROM theatres WHERE vendor_id = $1 ORDER BY city, name', [caller.id])
    return result.rows
  })

  // POST /vendor/theatres — the caller becomes the owner
  app.post('/theatres', { schema: { body: CreateTheatreBody } }, async (request, reply) => {
    const caller = getCaller(request)
    // An admin has no theatres of their own; theatres always belong to a vendor.
    if (caller.role !== 'vendor') throw forbidden('Only vendors can create theatres')

    const { name, city, address } = request.body
    const result = await pool.query(
      `INSERT INTO theatres (vendor_id, name, city, address)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [caller.id, name, city, address],
    )
    return reply.status(201).send(result.rows[0])
  })

  // POST /vendor/theatres/:id/screens — add a screen and generate all of its seats
  app.post(
    '/theatres/:id/screens',
    { schema: { params: IdParams, body: CreateScreenBody } },
    async (request, reply) => {
      const caller = getCaller(request)
      const { id: theatreId } = request.params
      const { name, rows, seatsPerRow, seatType = 'REGULAR' } = request.body

      const screen = await withTransaction(pool, async (client) => {
        await assertOwnsTheatre(client, caller, theatreId)

        const screenResult = await client.query(
          `INSERT INTO screens (theatre_id, name, total_seats)
           VALUES ($1, $2, $3) RETURNING *`,
          [theatreId, name, rows * seatsPerRow],
        )
        const created = screenResult.rows[0]

        // One set-based INSERT instead of rows × seatsPerRow round trips:
        // generate_series produces every (row, seat) pair inside Postgres.
        // chr(64 + 1) = 'A', chr(64 + 2) = 'B', ...
        await client.query(
          `INSERT INTO seats (screen_id, row_label, seat_number, seat_type)
           SELECT $1, chr(64 + r), s, $4
           FROM generate_series(1, $2::int) AS r, generate_series(1, $3::int) AS s`,
          [created.id, rows, seatsPerRow, seatType],
        )
        return created
      })

      return reply.status(201).send({
        screen,
        seats_created: rows * seatsPerRow,
        message: `Screen created with ${rows} rows × ${seatsPerRow} seats`,
      })
    },
  )

  // POST /vendor/shows — schedule a movie on one of my screens
  app.post('/shows', { schema: { body: CreateShowBody } }, async (request, reply) => {
    const caller = getCaller(request)
    const { movie_id, screen_id, start_time, price } = request.body

    const show = await withTransaction(pool, async (client) => {
      await assertOwnsScreen(client, caller, screen_id)

      const movie = await client.query('SELECT duration_mins FROM movies WHERE id = $1', [movie_id])
      if (movie.rows.length === 0) throw notFound('Movie not found')

      const startDate = new Date(start_time)
      const endDate = new Date(startDate.getTime() + movie.rows[0].duration_mins * 60_000)

      const showResult = await client.query(
        `INSERT INTO shows (movie_id, screen_id, start_time, end_time, price)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [movie_id, screen_id, startDate, endDate, price],
      )
      const created = showResult.rows[0]

      await client.query(
        `INSERT INTO show_seats (show_id, seat_id, status)
         SELECT $1, id, 'AVAILABLE' FROM seats WHERE screen_id = $2`,
        [created.id, screen_id],
      )
      return created
    })

    return reply.status(201).send(show)
  })
}

export default vendorRoutes
