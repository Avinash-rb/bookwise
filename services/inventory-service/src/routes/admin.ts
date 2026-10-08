import { type Pool, roleGuard } from '@bookwise/common'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { CreateMovieBody } from '../schemas'

// Platform-wide catalogue management, under /admin. Movies aren't owned by a
// vendor: the platform curates them and vendors schedule shows of them.
const adminRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (app, { pool }) => {
  app.addHook('onRequest', roleGuard('admin'))

  // POST /admin/movies — add a movie to the catalogue
  app.post('/movies', { schema: { body: CreateMovieBody } }, async (request, reply) => {
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

export default adminRoutes
