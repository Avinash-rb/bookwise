import { Pool, type PoolClient, type PoolConfig } from 'pg'
import type { Logger } from './logger'

export type { Pool, PoolClient }

export function createPool(connectionString: string, logger: Logger, options: PoolConfig = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Server-side guard: no single query may hold a connection (and its locks) forever.
    statement_timeout: 10_000,
    ...options,
  })

  // Errors on *idle* clients (e.g. the DB restarted) are emitted here; without a
  // listener Node would crash the process with an unhandled 'error' event.
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'))

  return pool
}

// Runs `fn` inside BEGIN/COMMIT on a single connection, rolling back on any
// error. Every multi-statement write in the services goes through this so a
// half-applied change can never be committed.
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The connection itself is unusable; make sure the pool discards it.
      broken = true
    }
    throw err
  } finally {
    client.release(broken)
  }
}
