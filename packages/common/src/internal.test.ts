import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { internalOnly } from './internal'

const TOKEN = 'a-very-long-shared-secret-for-tests-0123456789'
const guard = internalOnly(TOKEN)
const request = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest

describe('internalOnly', () => {
  it('lets a request with the right token through', async () => {
    await expect(guard(request({ 'x-internal-token': TOKEN }))).resolves.toBeUndefined()
  })

  it.each([
    ['no token', {}],
    ['a wrong token', { 'x-internal-token': 'nope' }],
    ['a token that is only a prefix', { 'x-internal-token': TOKEN.slice(0, -1) }],
  ])('rejects %s with 401', async (_case, headers) => {
    await expect(guard(request(headers))).rejects.toMatchObject({ statusCode: 401 })
  })
})
