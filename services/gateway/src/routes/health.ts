import { FastifyInstance } from 'fastify'

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (request, reply) => {
    return {
      status: 'ok',
      service: 'bookwise-gateway',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    }
  })
}
