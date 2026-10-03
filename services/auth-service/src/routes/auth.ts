import { unauthorized } from '@bookwise/common'
import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import type { AuthService } from '../auth.service'
import { LoginBody, RefreshBody, RegisterBody, SessionResponse, UserResponse } from '../schemas'
import type { TokenIssuer } from '../tokens'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const authRoutes: FastifyPluginAsyncTypebox<{ auth: AuthService; tokens: TokenIssuer }> = async (
  app,
  { auth, tokens },
) => {
  // POST /auth/register — create a customer or vendor account and log it in
  app.post(
    '/register',
    { schema: { body: RegisterBody, response: { 201: SessionResponse } } },
    async (request, reply) => reply.status(201).send(await auth.register(request.body)),
  )

  // POST /auth/login — email + password -> access token + refresh token
  app.post('/login', { schema: { body: LoginBody, response: { 200: SessionResponse } } }, async (request) =>
    auth.login(request.body.email, request.body.password),
  )

  // POST /auth/refresh — exchange a refresh token for a new pair (rotation)
  app.post(
    '/refresh',
    { schema: { body: RefreshBody, response: { 200: SessionResponse } } },
    async (request) => auth.refresh(request.body.refresh_token),
  )

  // POST /auth/logout — end the session family of this refresh token
  app.post('/logout', { schema: { body: RefreshBody } }, async (request, reply) => {
    await auth.logout(request.body.refresh_token)
    return reply.status(204).send()
  })

  // GET /auth/me — the current user, fresh from the DB.
  // The gateway verifies the access token and forwards the user id in the
  // x-user-id header; this service is not reachable from outside the network.
  app.get('/me', { schema: { response: { 200: UserResponse } } }, async (request) => {
    const userId = request.headers['x-user-id']
    if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) throw unauthorized()
    return auth.getUser(userId)
  })

  // GET /auth/.well-known/jwks.json — public key(s) for verifying access tokens
  app.get(
    '/.well-known/jwks.json',
    { schema: { response: { 200: Type.Unknown() } } },
    async (_request, reply) => {
      reply.header('cache-control', 'public, max-age=300')
      return tokens.jwks()
    },
  )
}

export default authRoutes
