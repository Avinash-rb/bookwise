import type { FastifyInstance } from 'fastify'
import config from '../config'

// KNOWN ISSUES (to be fixed with a proper upstream client):
//  - /api/events* forward to inventory /events, which does not exist (inventory serves /movies, /shows)
//  - no timeouts / circuit breaker; a down service turns into a 500 with a JSON parse error
//  - the caller's identity is not forwarded, so services can't enforce ownership

export default async function proxyRoutes(app: FastifyInstance) {
  // ── Order Service Routes ─────────────────────────────────
  app.post(
    '/api/orders',
    {
      preHandler: [app.authenticate], // JWT required
    },
    async (request, reply) => {
      const response = await fetch(`${config.services.order}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      })
      const data = await response.json()
      return reply.status(response.status).send(data)
    },
  )

  app.get(
    '/api/orders/:id',
    {
      preHandler: [app.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const response = await fetch(`${config.services.order}/orders/${id}`)
      const data = await response.json()
      return reply.status(response.status).send(data)
    },
  )

  // ── Inventory Service Routes ──────────────────────────────
  app.get('/api/events', async (_request, reply) => {
    // Public route — no auth needed to browse events
    const response = await fetch(`${config.services.inventory}/events`)
    const data = await response.json()
    return reply.status(response.status).send(data)
  })

  app.get('/api/events/:id/seats', async (request, reply) => {
    const { id } = request.params as { id: string }
    const response = await fetch(`${config.services.inventory}/events/${id}/seats`)
    const data = await response.json()
    return reply.status(response.status).send(data)
  })
}
