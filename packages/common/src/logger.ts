import pino, { type Logger, type LoggerOptions } from 'pino'

export type { Logger }

export interface LoggerConfig {
  service: string
  level?: string
  pretty?: boolean
}

// Structured JSON logs in production (one object per line, easy to ship to
// Loki/ELK and to query by field); human-readable output only in development.
export function createLogger({ service, level = 'info', pretty = false }: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-internal-token"]',
        'password',
        '*.password',
      ],
      censor: '[REDACTED]',
    },
  }

  if (pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
    }
  }

  return pino(options)
}
