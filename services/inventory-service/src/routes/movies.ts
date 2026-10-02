import { notFound, type Pool } from '@bookwise/common'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { CreateMovieBody, IdParams } from '../schemas'

const movieRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (app, { pool }) => {
  // GET /movies — list all movies
  app.get('/', async () => {
    const result = await pool.query('SELECT * FROM movies ORDER BY created_at DESC')
    return result.rows
  })

  // GET /movies/:id — get single movie
  app.get('/:id', { schema: { params: IdParams } }, async (request) => {
    const result = await pool.query('SELECT * FROM movies WHERE id = $1', [request.params.id])
    if (result.rows.length === 0) throw notFound('Movie not found')
    return result.rows[0]
  })

  // POST /movies — create movie
  app.post('/', { schema: { body: CreateMovieBody } }, async (request, reply) => {
    const { title, duration_mins, language = 'English', genre, rating } = request.body
    const result = await pool.query(
      `INSERT INTO movies (title, duration_mins, language, genre, rating)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [title, duration_mins, language, genre ?? null, rating ?? null],
    )
    return reply.status(201).send(result.rows[0])
  })
}

export default movieRoutes
