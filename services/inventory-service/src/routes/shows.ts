import { FastifyInstance } from 'fastify'
import pool from '../db/client'
import { CreateShowBody } from '../types'

export default async function showRoutes(app: FastifyInstance) {

  // GET /shows?movieId=... — list shows, optionally filter by movie
  app.get('/', async (request, reply) => {
    const { movieId } = request.query as { movieId?: string }

    const query = movieId
      ? `SELECT s.*, m.title as movie_title, m.duration_mins,
                sc.name as screen_name, t.name as theatre_name, t.city
         FROM shows s
         JOIN movies m ON s.movie_id = m.id
         JOIN screens sc ON s.screen_id = sc.id
         JOIN theatres t ON sc.theatre_id = t.id
         WHERE s.movie_id = $1
         ORDER BY s.start_time`
      : `SELECT s.*, m.title as movie_title, m.duration_mins,
                sc.name as screen_name, t.name as theatre_name, t.city
         FROM shows s
         JOIN movies m ON s.movie_id = m.id
         JOIN screens sc ON s.screen_id = sc.id
         JOIN theatres t ON sc.theatre_id = t.id
         ORDER BY s.start_time`

    const result = movieId
      ? await pool.query(query, [movieId])
      : await pool.query(query)

    return result.rows
  })

  // POST /shows — create a show + auto-populate show_seats
  app.post('/', async (request, reply) => {
    const { movie_id, screen_id, start_time, price } =
      request.body as CreateShowBody

    if (!movie_id || !screen_id || !start_time || !price) {
      return reply.status(400).send({
        error: 'movie_id, screen_id, start_time, price are required'
      })
    }

    // Get movie duration to calculate end_time
    const movieResult = await pool.query(
      'SELECT duration_mins FROM movies WHERE id = $1', [movie_id]
    )
    if (movieResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Movie not found' })
    }

    const durationMins = movieResult.rows[0].duration_mins
    const startDate = new Date(start_time)
    const endDate = new Date(startDate.getTime() + durationMins * 60000)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Create the show
      const showResult = await client.query(
        `INSERT INTO shows (movie_id, screen_id, start_time, end_time, price)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [movie_id, screen_id, startDate, endDate, price]
      )
      const show = showResult.rows[0]

      // 2. Auto-create show_seats for every seat in the screen
      await client.query(
        `INSERT INTO show_seats (show_id, seat_id, status)
         SELECT $1, id, 'AVAILABLE'
         FROM seats WHERE screen_id = $2`,
        [show.id, screen_id]
      )

      await client.query('COMMIT')
      return reply.status(201).send(show)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // GET /shows/:id/seats — seat availability for a show ← KEY ROUTE
  app.get('/:id/seats', async (request, reply) => {
    const { id: showId } = request.params as { id: string }

    const result = await pool.query(
      `SELECT
         ss.id as show_seat_id,
         ss.status,
         ss.reserved_by_order,
         s.row_label,
         s.seat_number,
         s.seat_type,
         sh.price
       FROM show_seats ss
       JOIN seats s ON ss.seat_id = s.id
       JOIN shows sh ON ss.show_id = sh.id
       WHERE ss.show_id = $1
       ORDER BY s.row_label, s.seat_number`,
      [showId]
    )

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Show not found or no seats' })
    }

    // Group by row for easier frontend rendering
    const byRow: Record<string, any[]> = {}
    for (const seat of result.rows) {
      if (!byRow[seat.row_label]) byRow[seat.row_label] = []
      byRow[seat.row_label].push(seat)
    }

    return {
      show_id: showId,
      total: result.rows.length,
      available: result.rows.filter(s => s.status === 'AVAILABLE').length,
      seats_by_row: byRow
    }
  })
  // ═══════════════════════════════════════════════════════════
  // SAGA ENDPOINTS — called by Order Service's Saga Orchestrator
  // ═══════════════════════════════════════════════════════════
  // POST /shows/:id/reserve — SAGA STEP 1: Reserve seats
  app.post('/:id/reserve', async (request, reply) => {
    const { id: showId } = request.params as { id: string }
    const { seat_ids, order_id } = request.body as {
      seat_ids: string[]   // show_seat_ids
      order_id: string
    }
    if (!seat_ids?.length || !order_id) {
      return reply.status(400).send({ error: 'seat_ids and order_id required' })
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Check all requested seats are AVAILABLE (with row-level lock)
      const checkResult = await client.query(
        `SELECT id, status FROM show_seats
         WHERE id = ANY($1) AND show_id = $2
         FOR UPDATE`,   // ← row-level lock prevents race conditions
        [seat_ids, showId]
      )
      // Validate all seats found
      if (checkResult.rows.length !== seat_ids.length) {
        await client.query('ROLLBACK')
        return reply.status(404).send({ error: 'Some seats not found' })
      }
      // Check none are already taken
      const unavailable = checkResult.rows.filter(s => s.status !== 'AVAILABLE')
      if (unavailable.length > 0) {
        await client.query('ROLLBACK')
        return reply.status(409).send({
          error: 'Seats already reserved',
          unavailable_seat_ids: unavailable.map(s => s.id)
        })
      }
      // Reserve all seats atomically
      await client.query(
        `UPDATE show_seats
         SET status = 'RESERVED', reserved_by_order = $1, reserved_at = NOW()
         WHERE id = ANY($2) AND show_id = $3`,
        [order_id, seat_ids, showId]
      )
      await client.query('COMMIT')
      return reply.status(200).send({
        message: 'Seats reserved',
        reserved_count: seat_ids.length,
        order_id
      })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
  // POST /shows/:id/confirm — SAGA STEP 3: Confirm seats (RESERVED → BOOKED)
  app.post('/:id/confirm', async (request, reply) => {
    const { id: showId } = request.params as { id: string }
    const { order_id } = request.body as { order_id: string }
    const result = await pool.query(
      `UPDATE show_seats
       SET status = 'BOOKED'
       WHERE show_id = $1 AND reserved_by_order = $2 AND status = 'RESERVED'
       RETURNING id`,
      [showId, order_id]
    )
    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: 'No reserved seats found for this order'
      })
    }
    return {
      message: 'Seats confirmed',
      confirmed_count: result.rows.length,
      order_id
    }
  })
  // POST /shows/:id/release — COMPENSATION: Release reserved seats
  app.post('/:id/release', async (request, reply) => {
    const { id: showId } = request.params as { id: string }
    const { order_id } = request.body as { order_id: string }
    const result = await pool.query(
      `UPDATE show_seats
       SET status = 'AVAILABLE', reserved_by_order = NULL, reserved_at = NULL
       WHERE show_id = $1 AND reserved_by_order = $2 AND status = 'RESERVED'
       RETURNING id`,
      [showId, order_id]
    )
    return {
      message: 'Seats released',
      released_count: result.rows.length,
      order_id
    }
  })

}
