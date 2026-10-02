import { unauthorized } from '@bookwise/common'
import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'

// Temporary in-memory users with plaintext passwords.
// Day 2 replaces this with a real auth-service (users DB, argon2 hashes,
// RS256 tokens, refresh-token rotation).
const USERS: Record<string, { password: string; role: string }> = {
  'avinash@bookwise.com': { password: 'password123', role: 'user' },
  'admin@bookwise.com': { password: 'admin123', role: 'admin' },
}

const LoginBody = Type.Object({
  email: Type.String({ format: 'email' }),
  password: Type.String({ minLength: 1, maxLength: 200 }),
})

const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // POST /auth/login → returns a JWT
  app.post('/auth/login', { schema: { body: LoginBody } }, async (request) => {
    const { email, password } = request.body

    const user = USERS[email]
    if (!user || user.password !== password) throw unauthorized('Invalid email or password')

    const token = app.jwt.sign({ email, role: user.role }, { expiresIn: '24h' })
    return { token, email, role: user.role }
  })

  // GET /auth/me → the logged-in user's token claims
  app.get('/auth/me', { preHandler: [app.authenticate] }, async (request) => request.user)
}

export default authRoutes
