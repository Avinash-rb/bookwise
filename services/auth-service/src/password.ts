import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// Password hashing with scrypt (built into Node, no native add-on to compile).
//
// Why a *slow, memory-hard* hash: a GPU computes billions of SHA-256 per
// second, so a leaked table of fast hashes falls to brute force quickly.
// scrypt makes every guess cost ~100 ms and ~128 MB of RAM.
//
// Parameters follow the OWASP Password Storage Cheat Sheet minimum for scrypt.

export interface ScryptParams {
  N: number // CPU/memory cost (power of 2)
  r: number // block size
  p: number // parallelism
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }

const KEY_LENGTH = 64
const SALT_LENGTH = 16

function derive(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // scrypt needs about 128 * N * r bytes; Node's default ceiling is 32 MB.
    const maxmem = 256 * N * r
    // NFKC normalisation: the same password typed on different keyboards/OSes
    // (composed vs decomposed accents) must produce the same hash.
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
}

// Stored as a self-describing string: scrypt$N$r$p$<salt base64>$<hash base64>.
// Because the parameters travel with the hash, they can be raised later
// without breaking existing accounts.
export async function hashPassword(password: string, params = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  // A random salt per password: identical passwords get different hashes, and
  // precomputed (rainbow) tables are useless.
  const salt = randomBytes(SALT_LENGTH)
  const key = await derive(password, salt, params)
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, hash] = stored.split('$')
  if (algorithm !== 'scrypt' || !n || !r || !p || !salt || !hash) return false

  const expected = Buffer.from(hash, 'base64')
  const actual = await derive(password, Buffer.from(salt, 'base64'), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  // Constant-time comparison: a normal `===` stops at the first differing byte,
  // and that timing difference can leak information.
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
