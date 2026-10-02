import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'
import type { Logger } from './logger'

// Minimal forward-only migration runner.
//
//  - Migrations are plain .sql files applied in filename order (001_, 002_, ...).
//  - Each file runs in its own transaction together with its bookkeeping row,
//    so a migration is either fully applied and recorded, or not at all.
//  - A Postgres advisory lock serialises runners: when two replicas of a
//    service boot at the same time only one applies migrations, the other
//    waits and then sees there is nothing left to do.
//  - A checksum of every applied file is stored; editing a migration that has
//    already run is refused (write a new migration instead).

const MIGRATION_LOCK_KEY = 72_017_001

const checksum = (sql: string) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')

export async function runMigrations(pool: Pool, dir: string, logger: Logger): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const client = await pool.connect()

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name        TEXT PRIMARY KEY,
          checksum    TEXT NOT NULL,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`)

      const { rows } = await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM schema_migrations',
      )
      const applied = new Map(rows.map((r) => [r.name, r.checksum]))
      const ran: string[] = []

      for (const file of files) {
        const sql = await readFile(path.join(dir, file), 'utf8')
        const sum = checksum(sql)
        const previous = applied.get(file)

        if (previous !== undefined) {
          if (previous !== sum) {
            throw new Error(`Migration ${file} was modified after it was applied`)
          }
          continue
        }

        await client.query('BEGIN')
        try {
          await client.query(sql)
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum])
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err })
        }

        logger.info({ migration: file }, 'applied migration')
        ran.push(file)
      }

      if (ran.length === 0) logger.info('database schema is up to date')
      return ran
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}
