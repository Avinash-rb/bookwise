import { notFound, type Pool } from '@bookwise/common'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { IdParams, ListShowsQuery, SeatMapResponse } from '../schemas'

// Public, read-only. Seat holds for bookings live in /internal/reservations.

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
}

export default showRoutes
