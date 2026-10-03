import { generateKeyPairSync } from 'node:crypto'
import { createVerifier } from 'fast-jwt'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTokenIssuer, generateRefreshToken, hashRefreshToken, type TokenIssuer } from './tokens'

const keyPair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

describe('access tokens (RS256)', () => {
  let issuer: TokenIssuer
  let publicKey: string

  beforeAll(() => {
    const keys = keyPair()
    publicKey = keys.publicKey
    issuer = createTokenIssuer({
      privateKeyPem: keys.privateKey,
      issuer: 'bookwise-auth',
      audience: 'bookwise',
      accessTtlSeconds: 900,
    })
  })

  it('issues a token that verifies with the PUBLIC key and carries the expected claims', () => {
    const token = issuer.issueAccessToken({ sub: 'user-1', role: 'vendor', email: 'v@bookwise.com' })
    const verify = createVerifier({
      key: publicKey,
      algorithms: ['RS256'],
      allowedIss: 'bookwise-auth',
      allowedAud: 'bookwise',
      complete: true,
    })
    const { header, payload } = verify(token)

    expect(header).toMatchObject({ alg: 'RS256', kid: issuer.kid })
    expect(payload).toMatchObject({ sub: 'user-1', role: 'vendor', email: 'v@bookwise.com' })
    expect(payload.exp - payload.iat).toBe(900)
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('gives every token a unique jti (so one token can be revoked on its own)', () => {
    const claims = { sub: 'user-1', role: 'customer' as const, email: 'c@bookwise.com' }
    const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString())
    expect(decode(issuer.issueAccessToken(claims)).jti).not.toBe(decode(issuer.issueAccessToken(claims)).jti)
  })

  it('rejects a token whose payload was tampered with', () => {
    const token = issuer.issueAccessToken({ sub: 'user-1', role: 'customer', email: 'c@bookwise.com' })
    const [header, payload, signature] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())
    const forged = Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url')

    const verify = createVerifier({ key: publicKey, algorithms: ['RS256'] })
    expect(() => verify(`${header}.${forged}.${signature}`)).toThrow()
  })

  it('rejects a token signed by a different key', () => {
    const other = createTokenIssuer({
      privateKeyPem: keyPair().privateKey,
      issuer: 'bookwise-auth',
      audience: 'bookwise',
      accessTtlSeconds: 900,
    })
    const token = other.issueAccessToken({ sub: 'user-1', role: 'admin', email: 'a@bookwise.com' })
    const verify = createVerifier({ key: publicKey, algorithms: ['RS256'] })
    expect(() => verify(token)).toThrow()
  })

  it('publishes only the public half of the key in the JWKS', () => {
    const [jwk] = issuer.jwks().keys
    expect(jwk).toMatchObject({ kty: 'RSA', kid: issuer.kid, alg: 'RS256', use: 'sig' })
    expect(jwk).toHaveProperty('n')
    expect(jwk).toHaveProperty('e')
    expect(jwk).not.toHaveProperty('d') // the private exponent must never leak
  })
})

describe('refresh tokens', () => {
  it('are 256-bit random, URL-safe strings', () => {
    const token = generateRefreshToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateRefreshToken()).not.toBe(token)
  })

  it('are stored as a deterministic SHA-256 hash', () => {
    const token = generateRefreshToken()
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token))
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashRefreshToken(token)).not.toContain(token)
  })
})
