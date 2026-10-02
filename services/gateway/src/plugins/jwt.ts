import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import config from '../config'

export default fp(async (app: FastifyInstance) => {
  // Register JWT plugin with our secret
  await app.register(fastifyJwt, {
    secret: config.jwtSecret
  })

  // Decorate app with a reusable auth hook
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch (err) {
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid or missing token'
      })
    }
  })
})
