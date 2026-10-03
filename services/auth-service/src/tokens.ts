import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { createSigner } from 'fast-jwt'

export type Role = 'customer' | 'vendor' | 'admin'

export interface AccessTokenClaims {
  sub: string // user id
  role: Role
  email: string
}

export interface TokenIssuerOptions {
  privateKeyPem: string
  issuer: string
  audience: string
  accessTtlSeconds: number
}

// Access tokens are RS256 JWTs: signed here with the PRIVATE key; the gateway
// verifies them with the PUBLIC key, so it can check tokens but never mint them.
export function createTokenIssuer({ privateKeyPem, issuer, audience, accessTtlSeconds }: TokenIssuerOptions) {
  const privateKey = createPrivateKey(privateKeyPem)
  const publicKey = createPublicKey(privateKey)

  // Key ID: a fingerprint of the public key, placed in every token header.
  // During key rotation, verifiers use it to pick the right public key.
  const kid = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64url')
    .slice(0, 16)

  const sign = createSigner({
    key: privateKeyPem,
    algorithm: 'RS256',
    kid,
    iss: issuer,
    aud: audience,
    expiresIn: accessTtlSeconds * 1000, // fast-jwt takes milliseconds
  })

  return {
    kid,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),

    // jti (JWT ID) uniquely identifies this token, so a single token can be
    // revoked (denylisted) on logout without affecting others.
    issueAccessToken: (claims: AccessTokenClaims): string => sign({ ...claims, jti: randomUUID() }),

    // JSON Web Key Set: the standard format for publishing public keys.
    jwks: () => ({
      keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }],
    }),
  }
}

export type TokenIssuer = ReturnType<typeof createTokenIssuer>

// Refresh tokens are NOT JWTs: just 256 random bits. They mean nothing on their
// own; their power comes from the matching row in our database, which is what
// makes them revocable.
export const generateRefreshToken = (): string => randomBytes(32).toString('base64url')

// Stored as SHA-256 (not scrypt): the token is already 256 bits of randomness,
// so it can't be brute-forced, and a fast hash lets us look it up by hash.
export const hashRefreshToken = (token: string): string => createHash('sha256').update(token).digest('hex')
