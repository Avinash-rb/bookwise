import { conflict, notFound, type Pool, withTransaction } from '@bookwise/common'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import {
  CreateShowBody,
  IdParams,
  ListShowsQuery,
  OrderRefBody,
  ReserveSeatsBody,
  SeatMapResponse,
} from '../schemas'

const SHOW_LIST_SQL = `
  SELECT s.*, m.title AS movie_title, m.duration_mins,
         sc.name AS screen_name, t.name AS theatre_name, t.city
  FROM shows s
  JOIN movies m   ON s.movie_id = m.id
  JOIN screens sc ON s.screen_id = sc.id
  JOIN theatres t ON sc.theatre_id = t.id`

const showRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (app, { pool }) => {
  // GET /shows?movieId=... — list shows, optionally filtered by movie
  app.get('/', { schema: { querystring: ListShowsQuery } }, async (request) => {
    const { movieId } = request.query
    const result = movieId
      ? await pool.query(`${SHOW_LIST_SQL} WHERE s.movie_id = $1 ORDER BY s.start_time`, [movieId])
      : await pool.query(`${SHOW_LIST_SQL} ORDER BY s.start_time`)
    return result.rows
  })

  // POST /shows — create a show and one show_seats row per seat in the screen
  app.post('/', { schema: { body: CreateShowBody } }, async (request, reply) => {
    const { movie_id, screen_id, start_time, price } = request.body

    const show = await withTransaction(pool, async (client) => {
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

  // GET /shows/:id/seats — seat availability for a show
  app.get(
    '/:id/seats',
    { schema: { params: IdParams, response: { 200: SeatMapResponse } } },
    async (request) => {
      const showId = request.params.id
      const result = await pool.query(
        `SELECT ss.id AS show_seat_id, ss.status, s.row_label, s.seat_number, s.seat_type, sh.price
         FROM show_seats ss
         JOIN seats s  ON ss.seat_id = s.id
         JOIN shows sh ON ss.show_id = sh.id
         WHERE ss.show_id = $1
         ORDER BY s.row_label, s.seat_number`,
        [showId],
      )
      if (result.rows.length === 0) throw notFound('Show not found or has no seats')

      // Group by row for easier seat-map rendering
      const seatsByRow: Record<string, (typeof result.rows)[number][]> = {}
      for (const seat of result.rows) {
        seatsByRow[seat.row_label] ??= []
        seatsByRow[seat.row_label]?.push(seat)
      }

      return {
        show_id: showId,
        total: result.rows.length,
        available: result.rows.filter((s) => s.status === 'AVAILABLE').length,
        seats_by_row: seatsByRow,
      }
    },
  )

  // ═══════════════════════════════════════════════════════════
  // SAGA ENDPOINTS — called by the order service's orchestrator
  // TODO: rework into idempotent /internal endpoints for the durable saga
  // ═══════════════════════════════════════════════════════════

  // POST /shows/:id/reserve — SAGA STEP 1: reserve seats
  app.post('/:id/reserve', { schema: { params: IdParams, body: ReserveSeatsBody } }, async (request) => {
    const showId = request.params.id
    const { seat_ids, order_id } = request.body

    await withTransaction(pool, async (client) => {
      // Row-level locks: a concurrent reservation of the same seats waits here
      // until this transaction commits, then sees the updated status.
      const check = await client.query(
        `SELECT id, status FROM show_seats
           WHERE id = ANY($1) AND show_id = $2
           FOR UPDATE`,
        [seat_ids, showId],
      )
      if (check.rows.length !== seat_ids.length) throw notFound('Some seats not found')

      const unavailable = check.rows.filter((s) => s.status !== 'AVAILABLE')
      if (unavailable.length > 0) {
        throw conflict('Seats already reserved', {
          unavailable_seat_ids: unavailable.map((s) => s.id),
        })
      }

      await client.query(
        `UPDATE show_seats
           SET status = 'RESERVED', reserved_by_order = $1, reserved_at = now()
           WHERE id = ANY($2) AND show_id = $3`,
        [order_id, seat_ids, showId],
      )
    })

    return { message: 'Seats reserved', reserved_count: seat_ids.length, order_id }
  })

  // POST /shows/:id/confirm — SAGA STEP 3: RESERVED -> BOOKED
  app.post('/:id/confirm', { schema: { params: IdParams, body: OrderRefBody } }, async (request) => {
    const { order_id } = request.body
    const result = await pool.query(
      `UPDATE show_seats
         SET status = 'BOOKED'
         WHERE show_id = $1 AND reserved_by_order = $2 AND status = 'RESERVED'
         RETURNING id`,
      [request.params.id, order_id],
    )
    if (result.rows.length === 0) throw notFound('No reserved seats found for this order')
    return { message: 'Seats confirmed', confirmed_count: result.rows.length, order_id }
  })

  // POST /shows/:id/release — COMPENSATION: release reserved seats
  app.post('/:id/release', { schema: { params: IdParams, body: OrderRefBody } }, async (request) => {
    const { order_id } = request.body
    const result = await pool.query(
      `UPDATE show_seats
         SET status = 'AVAILABLE', reserved_by_order = NULL, reserved_at = NULL
         WHERE show_id = $1 AND reserved_by_order = $2 AND status = 'RESERVED'
         RETURNING id`,
      [request.params.id, order_id],
    )
    return { message: 'Seats released', released_count: result.rows.length, order_id }
  })
}

export default showRoutes
