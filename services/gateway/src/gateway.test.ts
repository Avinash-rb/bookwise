import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { type App, createApp, createLogger } from '@bookwise/common'
import { createSigner } from 'fast-jwt'
import Fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import authPlugin, { bearerToken, denylistKey } from './plugins/auth'
import { createForwarder } from './proxy'
import apiRoutes from './routes/api'

const ISSUER = 'bookwise-auth'
const AUDIENCE = 'bookwise'

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

// Plays the role of auth-service: signs tokens with the private key.
const sign = createSigner({
  key: keys.privateKey,
  algorithm: 'RS256',
  iss: ISSUER,
  aud: AUDIENCE,
  expiresIn: 900_000,
})
const tokenFor = (role: 'customer' | 'vendor' | 'admin', sub = randomUUID()) =>
  sign({ sub, role, email: `${role}@test.com`, jti: randomUUID() })

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

// In-memory stand-in for the two Redis commands the auth plugin uses.
const store = new Map<string, { value: string; ttl: number }>()
const fakeRedis = fp(
  async (app) => {
    app.decorate('redis', {
      exists: async (key: string) => (store.has(key) ? 1 : 0),
      set: async (key: string, value: string, _ex: 'EX', ttl: number) => {
        store.set(key, { value, ttl })
        return 'OK'
      },
    } as unknown as FastifyInstance['redis'])
    // Rate limiting is tested separately against a real Redis.
    app.decorate('rateLimit', () => async () => {})
  },
  { name: 'bookwise-redis' },
)

let upstream: FastifyInstance
let gateway: App
let upstreamUrl: string

beforeAll(async () => {
  // A fake upstream that echoes back exactly what the gateway sent it.
  upstream = Fastify()
  upstream.get('/slow', async () => new Promise((resolve) => setTimeout(() => resolve({}), 500)))
  upstream.get('/html', async (_request, reply) => reply.type('text/html').send('<h1>oops</h1>'))
  upstream.all('/*', async (request) => ({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body ?? null,
  }))
  upstreamUrl = await upstream.listen({ port: 0, host: '127.0.0.1' })

  gateway = createApp(createLogger({ service: 'gateway-test', level: 'silent' }))
  await gateway.register(fakeRedis)
  await gateway.register(authPlugin, { publicKeyPem: keys.publicKey, issuer: ISSUER, audience: AUDIENCE })
  await gateway.register(apiRoutes, {
    forward: createForwarder({
      services: { auth: upstreamUrl, order: upstreamUrl, inventory: upstreamUrl },
      timeoutMs: 200,
    }),
  })
  await gateway.ready()
})

afterAll(async () => {
  await gateway.close()
  await upstream.close()
})

describe('routing', () => {
  it('forwards public catalogue reads to the right upstream path, with the query string', async () => {
    const res = await gateway.inject({ method: 'GET', url: '/api/shows?movie_id=abc' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ method: 'GET', url: '/shows?movie_id=abc' })
  })

  it('passes the request id on so one id follows the request across services', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/movies',
      headers: { 'x-request-id': 'req-123' },
    })
    expect(res.json().headers['x-request-id']).toBe('req-123')
  })

  it('does not expose internal endpoints (saga steps, payments)', async () => {
    const id = randomUUID()
    const admin = { authorization: `Bearer ${tokenFor('admin')}` }
    for (const url of [`/api/shows/${id}/reserve`, '/api/payments', '/api/payments/refund']) {
      const res = await gateway.inject({ method: 'POST', url, headers: admin, payload: {} })
      expect(res.statusCode).toBe(404)
    }
  })

  it('rejects non-UUID path ids before building the upstream URL (path traversal)', async () => {
    // Why it matters: the URL parser resolves dot segments, so an id of ".."
    // would turn GET /orders/.. into GET / on the upstream. Encoding the id
    // doesn't help: encodeURIComponent('..') is still '..'.
    expect(new URL(`/orders/${encodeURIComponent('..')}`, 'http://order-service').pathname).toBe('/')

    // Sent with node:http, which puts the path on the wire exactly as written.
    // (inject() and fetch() both normalise the dots away before sending; a
    // real attacker's raw HTTP request arrives untouched.)
    await gateway.listen({ port: 0, host: '127.0.0.1' })
    const { port } = gateway.server.address() as { port: number }
    const statusOf = (path: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        const headers = { authorization: `Bearer ${tokenFor('customer')}` }
        request({ host: '127.0.0.1', port, path, headers }, (res) => {
          res.resume()
          resolve(res.statusCode)
        })
          .on('error', reject)
          .end()
      })

    for (const path of ['/api/orders/..', '/api/orders/%2E%2E', '/api/orders/not-a-uuid']) {
      expect(await statusOf(path)).toBe(400)
    }
  })
})

describe('trust boundary: identity headers', () => {
  it('strips x-user-* headers sent by the client on public routes', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/movies',
      headers: { 'x-user-id': 'attacker', 'x-user-role': 'admin' },
    })
    expect(res.json().headers).not.toHaveProperty('x-user-id')
    expect(res.json().headers).not.toHaveProperty('x-user-role')
  })

  it('replaces forged identity headers with the identity from the verified token', async () => {
    const userId = randomUUID()
    const res = await gateway.inject({
      method: 'GET',
      url: `/api/orders/${randomUUID()}`,
      headers: {
        authorization: `Bearer ${tokenFor('customer', userId)}`,
        'x-user-id': 'someone-else',
        'x-user-role': 'admin',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().headers).toMatchObject({ 'x-user-id': userId, 'x-user-role': 'customer' })
  })

  it('never forwards the Authorization header or cookies upstream', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { authorization: `Bearer ${tokenFor('customer')}`, cookie: 'session=abc' },
    })
    expect(res.json().headers).not.toHaveProperty('authorization')
    expect(res.json().headers).not.toHaveProperty('cookie')
  })
})

describe('authentication', () => {
  const getOrders = (authorization?: string) =>
    gateway.inject({ method: 'GET', url: '/api/orders', headers: authorization ? { authorization } : {} })

  it('requires a token on protected routes (uniform 401 envelope)', async () => {
    const res = await getOrders()
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('rejects a token signed by a different private key', async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const forged = createSigner({ key: other.privateKey, algorithm: 'RS256', iss: ISSUER, aud: AUDIENCE })
    expect(
      (await getOrders(`Bearer ${forged({ sub: 'x', role: 'admin', email: 'a@b.c', jti: 'j' })}`)).statusCode,
    ).toBe(401)
  })

  it('rejects the "algorithm confusion" attack (HS256 signed with our public key)', async () => {
    // The attacker knows our public key (it's public) and uses it as an HMAC
    // secret. A verifier that trusted the token's "alg" header would accept it.
    const header = b64url({ alg: 'HS256', typ: 'JWT' })
    const now = Math.floor(Date.now() / 1000)
    const payload = b64url({
      sub: 'x',
      role: 'admin',
      email: 'a@b.c',
      jti: 'j',
      iss: ISSUER,
      aud: AUDIENCE,
      iat: now,
      exp: now + 900,
    })
    const signature = createHmac('sha256', keys.publicKey).update(`${header}.${payload}`).digest('base64url')
    expect((await getOrders(`Bearer ${header}.${payload}.${signature}`)).statusCode).toBe(401)
  })

  it('rejects expired tokens and tokens for another audience', async () => {
    const expired = createSigner({
      key: keys.privateKey,
      algorithm: 'RS256',
      iss: ISSUER,
      aud: AUDIENCE,
      expiresIn: 1,
    })
    const token = expired({ sub: 'x', role: 'customer', email: 'c@b.c', jti: 'j' })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect((await getOrders(`Bearer ${token}`)).statusCode).toBe(401)

    const otherAudience = createSigner({
      key: keys.privateKey,
      algorithm: 'RS256',
      iss: ISSUER,
      aud: 'other-app',
    })
    expect(
      (await getOrders(`Bearer ${otherAudience({ sub: 'x', role: 'customer', email: 'c@b.c', jti: 'j' })}`))
        .statusCode,
    ).toBe(401)
  })

  it('parses only well-formed Bearer headers', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer abc')).toBe('abc')
    expect(bearerToken('Basic abc')).toBeNull()
    expect(bearerToken('Bearer')).toBeNull()
    expect(bearerToken('Bearer a b')).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
  })
})

describe('authorization (roles)', () => {
  const createMovie = (role: 'customer' | 'vendor' | 'admin') =>
    gateway.inject({
      method: 'POST',
      url: '/api/movies',
      headers: { authorization: `Bearer ${tokenFor(role)}` },
      payload: { title: 'Dune' },
    })

  it('returns 403 when a logged-in user has the wrong role', async () => {
    expect((await createMovie('customer')).statusCode).toBe(403)
    expect((await createMovie('vendor')).statusCode).toBe(403)
  })

  it('forwards when the role is allowed, including the JSON body', async () => {
    const res = await createMovie('admin')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ method: 'POST', url: '/movies', body: { title: 'Dune' } })
  })

  it('only customers can place orders', async () => {
    const res = await gateway.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { authorization: `Bearer ${tokenFor('vendor')}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('logout', () => {
  it('denylists the access token until it would have expired', async () => {
    const token = tokenFor('customer')
    const authorization = `Bearer ${token}`
    expect(
      (await gateway.inject({ method: 'GET', url: '/api/orders', headers: { authorization } })).statusCode,
    ).toBe(200)

    const logout = await gateway.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization },
      payload: { refresh_token: 'r' },
    })
    expect(logout.statusCode).toBe(200) // whatever auth-service answers (the echo server says 200)
    expect(logout.json()).toMatchObject({ url: '/auth/logout', body: { refresh_token: 'r' } })

    const { jti } = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
    const entry = store.get(denylistKey(jti))
    expect(entry?.ttl).toBeGreaterThan(890)
    expect(entry?.ttl).toBeLessThanOrEqual(900)

    expect(
      (await gateway.inject({ method: 'GET', url: '/api/orders', headers: { authorization } })).statusCode,
    ).toBe(401)
  })

  it('still forwards logout when the access token is missing or invalid', async () => {
    const res = await gateway.inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: { refresh_token: 'r' },
    })
    expect(res.json()).toMatchObject({ url: '/auth/logout' })
  })
})

describe('upstream failures', () => {
  const forwardTo = async (services: Record<'auth' | 'order' | 'inventory', string>, path: string) => {
    const app = createApp(createLogger({ service: 'gateway-test', level: 'silent' }))
    const forward = createForwarder({ services, timeoutMs: 200 })
    app.get('/test', (request, reply) => forward(request, reply, 'inventory', path))
    const res = await app.inject({ method: 'GET', url: '/test' })
    await app.close()
    return res
  }
  const all = (url: string) => ({ auth: url, order: url, inventory: url })

  it('503 when the service is down (connection refused)', async () => {
    const res = await forwardTo(all('http://127.0.0.1:1'), '/movies')
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
  })

  it('504 when the service is too slow', async () => {
    const res = await forwardTo(all(upstreamUrl), '/slow')
    expect(res.statusCode).toBe(504)
    expect(res.json()).toMatchObject({ code: 'UPSTREAM_TIMEOUT' })
  })

  it('502 when the service answers something that is not JSON', async () => {
    const res = await forwardTo(all(upstreamUrl), '/html')
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ code: 'BAD_GATEWAY' })
  })
})
