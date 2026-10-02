import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import { FastifyInstance } from 'fastify'

export default fp(async (app: FastifyInstance) => {
  await app.register(rateLimit, {
    max: 100,           // max 100 requests...
    timeWindow: 60000,  // ...per 60 seconds per IP
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'You have exceeded the rate limit. Try again in a minute.'
    })
  })
})
