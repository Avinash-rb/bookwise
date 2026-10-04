import { AppError } from '@bookwise/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Upstream } from './config'

// Only these client headers are passed on. A whitelist, not a blacklist:
// anything we didn't think of (x-user-id, x-internal-token, cookies...) is
// dropped by default instead of leaking through.
const FORWARDED_REQUEST_HEADERS = ['accept', 'idempotency-key'] as const
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'location', 'retry-after'] as const

const badGateway = () => new AppError(502, 'BAD_GATEWAY', 'Upstream service sent an invalid response')
const upstreamUnavailable = () => new AppError(503, 'UPSTREAM_UNAVAILABLE', 'Service temporarily unavailable')
const upstreamTimeout = () => new AppError(504, 'UPSTREAM_TIMEOUT', 'Service took too long to respond')

export function upstreamHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = { 'x-request-id': request.id }
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  // Identity comes ONLY from the verified token, never from the client.
  if (request.user) {
    headers['x-user-id'] = request.user.id
    headers['x-user-role'] = request.user.role
    headers['x-user-email'] = request.user.email
  }
  return headers
}

export interface ForwarderOptions {
  services: Record<Upstream, string> // base URL per upstream service
  timeoutMs: number
}

export type Forward = (
  request: FastifyRequest,
  reply: FastifyReply,
  upstream: Upstream,
  path: string,
) => Promise<FastifyReply>

// Returns forward(): sends the request to `path` on an upstream service and
// relays the answer.
//
// No retries here on purpose: if a POST /orders times out we don't know whether
// the order was created, and retrying could book twice. Safe retries need an
// idempotency key, which the order flow gets later.
export function createForwarder({ services, timeoutMs }: ForwarderOptions): Forward {
  return async (request, reply, upstream, path) => {
    const url = new URL(path, services[upstream])
    const queryStart = request.url.indexOf('?')
    if (queryStart !== -1) url.search = request.url.slice(queryStart)

    const headers = upstreamHeaders(request)
    const hasBody = request.body !== undefined && request.body !== null
    if (hasBody) headers['content-type'] = 'application/json'

    let response: Response
    let text: string
    try {
      response = await fetch(url, {
        method: request.method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
        redirect: 'manual',
        // Covers connecting, waiting for headers AND reading the body.
        signal: AbortSignal.timeout(timeoutMs),
      })
      text = await response.text()
    } catch (err) {
      request.log.warn({ err, upstream, path }, 'upstream request failed')
      // TimeoutError: the service is up but slow. Anything else (connection
      // refused, DNS failure, reset): the service is down or restarting.
      throw (err as Error).name === 'TimeoutError' ? upstreamTimeout() : upstreamUnavailable()
    }

    // Our services always answer JSON (or nothing). Anything else means
    // something in between broke, e.g. an HTML error page.
    const contentType = response.headers.get('content-type') ?? ''
    if (text && !contentType.includes('application/json')) {
      request.log.error(
        { upstream, path, status: response.status, contentType },
        'non-JSON upstream response',
      )
      throw badGateway()
    }

    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name)
      if (value) reply.header(name, value)
    }
    // The body is relayed as-is (already JSON), without parsing and re-encoding.
    return reply.status(response.status).send(text || undefined)
  }
}
