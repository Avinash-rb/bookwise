import { FastifyInstance } from 'fastify'
import pool from '../db/client'
import { CreateMovieBody } from '../types'

export default async function movieRoutes(app: FastifyInstance) {

  // GET /movies — list all movies
  app.get('/', async (request, reply) => {
    const result = await pool.query(
      'SELECT * FROM movies ORDER BY created_at DESC'
    )
    return result.rows
  })

  // GET /movies/:id — get single movie
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await pool.query(
      'SELECT * FROM movies WHERE id = $1',
      [id]
    )
    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Movie not found' })
    }
    return result.rows[0]
  })

  // POST /movies — create movie
  app.post('/', async (request, reply) => {
    const { title, duration_mins, language = 'English', genre, rating } =
      request.body as CreateMovieBody

    if (!title || !duration_mins) {
      return reply.status(400).send({ error: 'title and duration_mins are required' })
    }

    const result = await pool.query(
      `INSERT INTO movies (title, duration_mins, language, genre, rating)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [title, duration_mins, language, genre, rating]
    )
    return reply.status(201).send(result.rows[0])
  })
}
