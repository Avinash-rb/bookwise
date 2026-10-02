import fastifyJwt from '@fastify/jwt'
import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import config from '../config'

// TypeScript "declaration merging": teach the Fastify types about what this
// plugin adds at runtime. Without it `app.authenticate` is a type error
// (the original code only ran because tsx skips type checking).
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export interface JwtUser {
  email: string
  role: string
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser
    user: JwtUser
  }
}

export default fp(
  async (app) => {
    await app.register(fastifyJwt, { secret: config.jwtSecret })

    app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify()
      } catch {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          code: 'UNAUTHORIZED',
          message: 'Invalid or missing token',
        })
      }
    })
  },
  { name: 'bookwise-jwt' },
)
