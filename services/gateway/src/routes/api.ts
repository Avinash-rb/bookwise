import { type FastifyPluginAsyncTypebox, Type } from '@fastify/type-provider-typebox'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Upstream } from '../config'
import type { Role } from '../plugins/auth'
import { byIp, byUser, POLICIES } from '../plugins/rateLimit'
import type { Forward } from '../proxy'

interface RouteSpec {
  method: 'GET' | 'POST'
  url: string // public path on the gateway
  upstream: Upstream
  path: string // path on the upstream service; :id is filled from the validated URL
  access: 'public' | 'authenticated' | Role[]
  limit?: 'auth' | 'booking'
}

const ANYONE_LOGGED_IN = 'authenticated'

// The whole public API in one table: what is exposed, where it goes and who may
// call it. Anything not listed here (saga endpoints like /shows/:id/reserve,
// all of payment-service) is unreachable from outside.
// biome-ignore format: one route per line reads as a table
const ROUTES: RouteSpec[] = [
  // ── Auth (public; strict per-IP limit against password guessing) ──
  { method: 'POST', url: '/api/auth/register', upstream: 'auth', path: '/auth/register', access: 'public', limit: 'auth' },
  { method: 'POST', url: '/api/auth/login', upstream: 'auth', path: '/auth/login', access: 'public', limit: 'auth' },
  { method: 'POST', url: '/api/auth/refresh', upstream: 'auth', path: '/auth/refresh', access: 'public', limit: 'auth' },
  { method: 'GET', url: '/api/auth/me', upstream: 'auth', path: '/auth/me', access: ANYONE_LOGGED_IN },

  // ── Catalogue (public reads) ──
  { method: 'GET', url: '/api/movies', upstream: 'inventory', path: '/movies', access: 'public' },
  { method: 'GET', url: '/api/movies/:id', upstream: 'inventory', path: '/movies/:id', access: 'public' },
  { method: 'GET', url: '/api/theatres', upstream: 'inventory', path: '/theatres', access: 'public' },
  { method: 'GET', url: '/api/shows', upstream: 'inventory', path: '/shows', access: 'public' },
  { method: 'GET', url: '/api/shows/:id/seats', upstream: 'inventory', path: '/shows/:id/seats', access: 'public' },

  // ── Admin: the platform curates the movie catalogue ──
  { method: 'POST', url: '/api/admin/movies', upstream: 'inventory', path: '/admin/movies', access: ['admin'] },

  // ── Vendors run theatres (inventory-service checks they own the theatre) ──
  { method: 'GET', url: '/api/vendor/theatres', upstream: 'inventory', path: '/vendor/theatres', access: ['vendor', 'admin'] },
  { method: 'POST', url: '/api/vendor/theatres', upstream: 'inventory', path: '/vendor/theatres', access: ['vendor'] },
  { method: 'POST', url: '/api/vendor/theatres/:id/screens', upstream: 'inventory', path: '/vendor/theatres/:id/screens', access: ['vendor', 'admin'] },
  { method: 'POST', url: '/api/vendor/shows', upstream: 'inventory', path: '/vendor/shows', access: ['vendor', 'admin'] },

  // ── Orders (order-service checks the order belongs to the caller) ──
  { method: 'POST', url: '/api/orders', upstream: 'order', path: '/orders', access: ['customer'], limit: 'booking' },
  { method: 'GET', url: '/api/orders', upstream: 'order', path: '/orders', access: ['customer', 'admin'] },
  { method: 'GET', url: '/api/orders/:id', upstream: 'order', path: '/orders/:id', access: ['customer', 'admin'] },
]

// Path ids are validated as UUIDs HERE, before they are put into the upstream
// URL. Without this, GET /api/orders/.. would become GET /orders/.. which the
// URL parser normalises to GET / (path traversal onto another route).
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

const toUpstreamPath = (template: string, params: unknown) =>
  template.replace(':id', encodeURIComponent((params as { id?: string }).id ?? ''))

type Hook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>

const apiRoutes: FastifyPluginAsyncTypebox<{ forward: Forward }> = async (app, { forward }) => {
  for (const route of ROUTES) {
    // Hooks run in this order: cheap per-IP limit -> who are you -> are you
    // allowed -> per-user limit.
    const preHandler: Hook[] = []
    if (route.limit === 'auth') preHandler.push(app.rateLimit(POLICIES.auth, byIp))
    if (route.access !== 'public') preHandler.push(app.authenticate)
    if (Array.isArray(route.access)) preHandler.push(app.requireRole(...route.access))
    if (route.limit === 'booking') preHandler.push(app.rateLimit(POLICIES.booking, byUser))

    app.route({
      method: route.method,
      url: route.url,
      schema: route.url.includes(':id') ? { params: IdParams } : {},
      preHandler,
      handler: (request, reply) =>
        forward(request, reply, route.upstream, toUpstreamPath(route.path, request.params)),
    })
  }

  // POST /api/auth/logout — the one route the gateway handles itself as well:
  // auth-service ends the refresh-token session, and the gateway kills the
  // current access token (it can't be "deleted", so its jti is denylisted).
  // Works without a valid access token too, so an expired one can still log out.
  app.post('/api/auth/logout', { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    if (request.user) await app.revokeAccessToken(request.user)
    return forward(request, reply, 'auth', '/auth/logout')
  })
}

export default apiRoutes
