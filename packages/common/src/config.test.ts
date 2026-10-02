import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { baseEnvSchema, loadConfig, port } from './config'

const schema = baseEnvSchema.extend({
  PORT: port(3000),
  DB_URL: z.url(),
  RUN_MIGRATIONS: z.stringbool().default(true),
})

describe('loadConfig', () => {
  it('parses and coerces a valid environment', () => {
    const config = loadConfig(schema, {
      PORT: '4000',
      DB_URL: 'postgresql://u:p@db:5432/x',
      RUN_MIGRATIONS: 'false',
    })
    expect(config).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 4000,
      DB_URL: 'postgresql://u:p@db:5432/x',
      RUN_MIGRATIONS: false,
    })
  })

  it('applies defaults', () => {
    const config = loadConfig(schema, { DB_URL: 'postgresql://db/x' })
    expect(config.PORT).toBe(3000)
    expect(config.RUN_MIGRATIONS).toBe(true)
  })

  it('fails fast listing every invalid variable', () => {
    expect(() => loadConfig(schema, { PORT: 'abc', NODE_ENV: 'staging' })).toThrowError(
      /PORT[\s\S]*NODE_ENV|NODE_ENV[\s\S]*PORT/,
    )
    expect(() => loadConfig(schema, {})).toThrowError(/DB_URL/)
  })
})
