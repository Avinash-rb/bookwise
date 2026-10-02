import { FastifyInstance } from 'fastify'
import pool from '../db/client'
import { CreateTheatreBody, CreateScreenBody } from '../types'

export default async function theatreRoutes(app: FastifyInstance) {

  // GET /theatres — list all theatres
  app.get('/', async () => {
    const result = await pool.query(
      'SELECT * FROM theatres ORDER BY city, name'
    )
    return result.rows
  })

  // POST /theatres — create theatre
  app.post('/', async (request, reply) => {
    const { name, city, address } = request.body as CreateTheatreBody

    if (!name || !city || !address) {
      return reply.status(400).send({ error: 'name, city, address required' })
    }

    const result = await pool.query(
      `INSERT INTO theatres (name, city, address)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, city, address]
    )
    return reply.status(201).send(result.rows[0])
  })

  // POST /theatres/:id/screens — add a screen to a theatre
  // Also auto-creates all seat rows for the screen
  app.post('/:id/screens', async (request, reply) => {
    const { id: theatreId } = request.params as { id: string }
    const { name, rows, seatsPerRow, seatType = 'REGULAR' } =
      request.body as CreateScreenBody

    if (!name || !rows || !seatsPerRow) {
      return reply.status(400).send({ error: 'name, rows, seatsPerRow required' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // 1. Create the screen
      const screenResult = await client.query(
        `INSERT INTO screens (theatre_id, name, total_seats)
         VALUES ($1, $2, $3) RETURNING *`,
        [theatreId, name, rows * seatsPerRow]
      )
      const screen = screenResult.rows[0]

      // 2. Auto-create all seats (Row A Seat 1 ... Row J Seat 15)
      const rowLabels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, rows)
      const seatInserts: Promise<any>[] = []

      for (const rowLabel of rowLabels) {
        for (let seatNum = 1; seatNum <= seatsPerRow; seatNum++) {
          seatInserts.push(
            client.query(
              `INSERT INTO seats (screen_id, row_label, seat_number, seat_type)
               VALUES ($1, $2, $3, $4)`,
              [screen.id, rowLabel, seatNum, seatType]
            )
          )
        }
      }
      await Promise.all(seatInserts)
      await client.query('COMMIT')

      return reply.status(201).send({
        screen,
        seats_created: rows * seatsPerRow,
        message: `Screen created with ${rows} rows × ${seatsPerRow} seats`
      })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}
