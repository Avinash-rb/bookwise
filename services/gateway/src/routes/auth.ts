import { FastifyInstance } from 'fastify'

// Temporary in-memory users — we'll move to DB on Day 4
const USERS: Record<string, { password: string; role: string }> = {
  'avinash@bookwise.com': { password: 'password123', role: 'user' },
  'admin@bookwise.com':   { password: 'admin123',    role: 'admin' },
}

export default async function authRoutes(app: FastifyInstance) {

  // POST /auth/login → returns JWT token
  app.post('/auth/login', async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string }

    // Validate input
    if (!email || !password) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Email and password are required'
      })
    }

    // Check user exists and password matches
    const user = USERS[email]
    if (!user || user.password !== password) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid email or password'
      })
    }

    // Sign JWT token — expires in 24 hours
    const token = app.jwt.sign(
      { email, role: user.role },
      { expiresIn: '24h' }
    )

    return reply.status(200).send({ token, email, role: user.role })
  })

  // GET /auth/me → returns logged-in user info (requires valid JWT)
  app.get('/auth/me', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    // request.user is the decoded JWT payload (set by jwtVerify)
    return request.user
  })
}
