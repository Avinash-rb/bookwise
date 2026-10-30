// Helpers for the proof scripts: they drive the running Docker stack.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const run = (args, input) => {
  const res = spawnSync('docker', args, { input, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`docker ${args.join(' ')} failed:\n${res.stderr}`)
  return res.stdout.trim()
}

// Runs a script inside the order-service container, i.e. on the private
// Docker network where the services are reachable (the host only sees the
// gateway). lib.network.mjs is prepended, so the script can use its helpers.
// Returns the script's output as text.
export const runInNetwork = (file) => {
  const lib = readFileSync(new URL('./lib.network.mjs', import.meta.url), 'utf8')
  const script = readFileSync(file, 'utf8')
  return run(
    ['exec', '-i', 'bookwise-order-service-1', 'node', '--input-type=module', '-'],
    `${lib}\n${script}`,
  )
}

// psql in one of the database containers: db = 'order' | 'inventory' | 'payment' | 'auth'
export const sql = (db, query) =>
  run(['exec', `bookwise-${db}-db`, 'psql', '-U', 'postgres', '-d', `${db}db`, '-tAc', query])

export const docker = (...args) => run(args)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitHealthy(container, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (docker('inspect', '-f', '{{.State.Health.Status}}', container) === 'healthy') return
    await sleep(1000)
  }
  throw new Error(`${container} did not become healthy`)
}
