import { STATUS_CODES } from 'node:http'
import type { FastifyError, FastifyInstance } from 'fastify'

// Errors we throw on purpose. Anything else reaching the error handler is a bug
// and is reported to the client as a generic 500 (details only go to the logs).
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details)
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message)
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'FORBIDDEN', message)
export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message)
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details)

export interface ErrorBody {
  statusCode: number
  error: string
  code: string
  message: string
  details?: unknown
}

const body = (statusCode: number, code: string, message: string, details?: unknown): ErrorBody => ({
  statusCode,
  error: STATUS_CODES[statusCode] ?? 'Error',
  code,
  message,
  ...(details === undefined ? {} : { details }),
})

// Postgres SQLSTATE codes we can translate into a meaningful client error
// instead of leaking a 500. https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  '22P02': { status: 400, code: 'INVALID_INPUT', message: 'Malformed input value' },
  '23505': { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  '23503': { status: 422, code: 'INVALID_REFERENCE', message: 'Referenced resource does not exist' },
  '23514': { status: 400, code: 'CONSTRAINT_VIOLATION', message: 'Value violates a constraint' },
}

const pgCode = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code.length === 5 ? code : undefined
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.statusCode, err.code, err.message, err.details))
    }

    if (err.validation) {
      return reply.status(400).send(body(400, 'VALIDATION_ERROR', err.message, err.validation))
    }

    const mapped = PG_ERRORS[pgCode(err) ?? '']
    if (mapped) {
      request.log.warn({ err }, 'database constraint error')
      return reply.status(mapped.status).send(body(mapped.status, mapped.code, mapped.message))
    }

    // Fastify's own 4xx errors (body too large, unsupported media type, rate limit...)
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send(body(err.statusCode, err.code ?? 'CLIENT_ERROR', err.message))
    }

    request.log.error({ err }, 'unhandled error')
    return reply.status(500).send(body(500, 'INTERNAL_ERROR', 'Something went wrong'))
  })

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(body(404, 'ROUTE_NOT_FOUND', `Route ${request.method} ${request.url} not found`))
  })
}
