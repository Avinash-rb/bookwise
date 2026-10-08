import type { Pool } from '@bookwise/common'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

// Public, read-only. Creating theatres and screens lives under /vendor.
const theatreRoutes: FastifyPluginAsyncTypebox<{ pool: Pool }> = async (app, { pool }) => {
  // GET /theatres — list all theatres. Explicit columns: vendor_id is an
  // internal user id and isn't shown publicly.
  app.get('/', async () => {
    const result = await pool.query(
      'SELECT id, name, city, address, created_at FROM theatres ORDER BY city, name',
    )
    return result.rows
  })
}

export default theatreRoutes
