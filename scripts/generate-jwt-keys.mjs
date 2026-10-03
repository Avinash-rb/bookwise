// Generates the RSA key pair used to sign (private) and verify (public) access tokens.
//   npm run keys:generate            -> creates secrets/jwt-private.pem + secrets/jwt-public.pem
//   npm run keys:generate -- --force -> replaces existing keys (invalidates all issued tokens)
//
// The secrets/ folder is git-ignored and docker-ignored: keys must never be
// committed or baked into an image. In production they would come from a
// secrets manager (Vault, AWS Secrets Manager, Kubernetes Secrets).
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../secrets/', import.meta.url))
const privatePath = `${dir}jwt-private.pem`
const publicPath = `${dir}jwt-public.pem`

if (existsSync(privatePath) && !process.argv.includes('--force')) {
  console.log(`Keys already exist in ${dir} (use --force to replace them).`)
  process.exit(0)
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

mkdirSync(dir, { recursive: true })
writeFileSync(privatePath, privateKey, { mode: 0o600 })
writeFileSync(publicPath, publicKey)
console.log(`Wrote ${privatePath}\nWrote ${publicPath}`)
