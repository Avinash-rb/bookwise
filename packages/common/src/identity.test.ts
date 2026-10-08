import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { getCaller, requireRole } from './identity'

const USER_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'

const request = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest
const asCustomer = { 'x-user-id': USER_ID, 'x-user-role': 'customer', 'x-user-email': 'c@test.com' }

describe('getCaller', () => {
  it('reads the identity set by the gateway', () => {
    expect(getCaller(request(asCustomer))).toEqual({ id: USER_ID, role: 'customer', email: 'c@test.com' })
  })

  it.each([
    ['no headers at all', {}],
    ['a non-UUID user id', { ...asCustomer, 'x-user-id': 'admin' }],
    ['an unknown role', { ...asCustomer, 'x-user-role': 'superuser' }],
    ['a missing email', { 'x-user-id': USER_ID, 'x-user-role': 'customer' }],
  ])('rejects %s with 401', (_case, headers) => {
    expect(() => getCaller(request(headers))).toThrow(expect.objectContaining({ statusCode: 401 }))
  })
})

describe('requireRole', () => {
  it('returns the caller when the role is allowed', () => {
    expect(requireRole(request(asCustomer), 'customer', 'admin').id).toBe(USER_ID)
  })

  it('rejects a known caller with the wrong role with 403', () => {
    expect(() => requireRole(request(asCustomer), 'vendor')).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    )
  })
})
