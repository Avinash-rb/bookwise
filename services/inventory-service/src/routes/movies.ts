import { notFound, type Pool } from '@bookwise/common'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { IdParams } from '../schemas'

// Public, read-only. Adding movies lives under /admin.
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
}

export default movieRoutes
