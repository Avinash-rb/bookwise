import type { FastifyRequest } from 'fastify'
import { forbidden, unauthorized } from './errors'

export type Role = 'customer' | 'vendor' | 'admin'
const ROLES: readonly string[] = ['customer', 'vendor', 'admin']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Who is calling, as established by the gateway.
export interface Caller {
  id: string
  role: Role
  email: string
}

// Reads the identity headers the gateway sets from the verified access token.
// Services are reachable only through the gateway, which strips any x-user-*
// headers a client sends, so these can be trusted. Missing or malformed
// headers mean the request didn't come through an authenticated route -> 401.
export function getCaller(request: FastifyRequest): Caller {
  const id = request.headers['x-user-id']
  const role = request.headers['x-user-role']
  const email = request.headers['x-user-email']
  if (
    typeof id !== 'string' ||
    !UUID_PATTERN.test(id) ||
    typeof role !== 'string' ||
    !ROLES.includes(role) ||
    typeof email !== 'string'
  ) {
    throw unauthorized()
  }
  return { id, role: role as Role, email }
}

// Defence in depth: the gateway already checks roles per route, but each
// service checks again, so one misconfigured gateway route can't open it up.
export function requireRole(request: FastifyRequest, ...roles: Role[]): Caller {
  const caller = getCaller(request)
  if (!roles.includes(caller.role)) throw forbidden()
  return caller
}

// The same check as a hook, to protect a whole group of routes at once:
//   app.addHook('onRequest', roleGuard('vendor', 'admin'))
export const roleGuard =
  (...roles: Role[]) =>
  async (request: FastifyRequest) => {
    requireRole(request, ...roles)
  }
