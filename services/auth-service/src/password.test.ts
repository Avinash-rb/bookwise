import { describe, expect, it } from 'vitest'
import { hashPassword, type ScryptParams, verifyPassword } from './password'

// Cheap parameters keep the suite fast; production uses DEFAULT_SCRYPT_PARAMS.
const FAST: ScryptParams = { N: 2 ** 10, r: 8, p: 1 }

describe('password hashing', () => {
  it('stores a self-describing scrypt hash, never the password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST)
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(hash).not.toContain('correct horse')
  })

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('s3cret-passw0rd', FAST)
    await expect(verifyPassword('s3cret-passw0rd', hash)).resolves.toBe(true)
    await expect(verifyPassword('s3cret-passw0rd!', hash)).resolves.toBe(false)
  })

  it('salts every hash: the same password gives different hashes', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password', FAST),
      hashPassword('same-password', FAST),
    ])
    expect(a).not.toBe(b)
    await expect(verifyPassword('same-password', a)).resolves.toBe(true)
    await expect(verifyPassword('same-password', b)).resolves.toBe(true)
  })

  it('treats differently-encoded but identical Unicode passwords as equal', async () => {
    // Built from code points so the difference stays visible in the source.
    const composed = `caf${String.fromCodePoint(0x00e9)}-password` // é as ONE code point
    const decomposed = `cafe${String.fromCodePoint(0x0301)}-password` // e + combining accent
    expect(composed).not.toBe(decomposed) // different strings...
    const hash = await hashPassword(composed, FAST)
    await expect(verifyPassword(decomposed, hash)).resolves.toBe(true)
  })

  it('rejects malformed stored hashes instead of throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false)
    await expect(verifyPassword('anything', 'bcrypt$1$2$3$x$y')).resolves.toBe(false)
  })
})
