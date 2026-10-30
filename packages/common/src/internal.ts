import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import { unauthorized } from './errors'

export const INTERNAL_TOKEN_HEADER = 'x-internal-token'

// Env schema for the shared service-to-service secret.
export const internalServiceToken = () =>
  z.string().min(32, 'INTERNAL_SERVICE_TOKEN must be at least 32 characters')

// Guards /internal/* routes: callable only by our own services, which send a
// shared secret. The gateway never routes /internal and never forwards this
// header, so this is a second lock behind the network one: something inside
// the network that isn't one of our services still can't run saga steps.
export function internalOnly(expectedToken: string) {
  // Compare SHA-256 digests: equal length always, so timingSafeEqual works and
  // neither the token's content nor its length leaks through response timing.
  const expected = createHash('sha256').update(expectedToken).digest()

  return async (request: FastifyRequest) => {
    const given = request.headers[INTERNAL_TOKEN_HEADER]
    const digest = createHash('sha256')
      .update(typeof given === 'string' ? given : '')
      .digest()
    if (typeof given !== 'string' || !timingSafeEqual(digest, expected)) {
      throw unauthorized('Internal endpoint')
    }
  }
}
