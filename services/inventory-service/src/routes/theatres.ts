import { notFound, type Pool, withTransaction } from '@bookwise/common'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { CreateScreenBody, CreateTheatreBody, IdParams } from '../schemas'

const theatreRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (app, { pool }) => {
  // GET /theatres — list all theatres
  app.get('/', async () => {
    const result = await pool.query('SELECT * FROM theatres ORDER BY city, name')
    return result.rows
  })

  // POST /theatres — create theatre
  app.post('/', { schema: { body: CreateTheatreBody } }, async (request, reply) => {
    const { name, city, address } = request.body
    const result = await pool.query(
      `INSERT INTO theatres (name, city, address)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, city, address],
    )
    return reply.status(201).send(result.rows[0])
  })

  // POST /theatres/:id/screens — add a screen and generate all of its seats
  app.post(
    '/:id/screens',
    { schema: { params: IdParams, body: CreateScreenBody } },
    async (request, reply) => {
      const { id: theatreId } = request.params
      const { name, rows, seatsPerRow, seatType = 'REGULAR' } = request.body

      const screen = await withTransaction(pool, async (client) => {
        const theatre = await client.query('SELECT 1 FROM theatres WHERE id = $1', [theatreId])
        if (theatre.rowCount === 0) throw notFound('Theatre not found')

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
}

export default theatreRoutes
