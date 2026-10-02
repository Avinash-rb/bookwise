import { randomUUID } from 'node:crypto'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyBaseLogger } from 'fastify'
import { registerErrorHandler } from './errors'
import type { Logger } from './logger'

export function createApp(logger: Logger) {
  // Widen pino's concrete Logger to Fastify's base logger type so the app stays
  // compatible with plugins typed against a plain FastifyInstance.
  const loggerInstance: FastifyBaseLogger = logger
  const app = Fastify({
    loggerInstance,
    // Reuse the caller's request id (set by the gateway) so one id follows a
    // request across every service's logs; mint one if it's missing.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  registerErrorHandler(app)
  return app
}

export type App = ReturnType<typeof createApp>

export interface StartOptions {
  port: number
  host?: string
  logger: Logger
  shutdownTimeoutMs?: number
}

// Graceful shutdown: on SIGTERM (what Docker/Kubernetes send) we stop accepting
// new connections, let in-flight requests finish, run onClose hooks (closing DB
// pools etc.) and only then exit. A hard deadline makes sure a stuck request
// can't keep the container alive forever.
export async function startServer(app: App, options: StartOptions): Promise<void> {
  const { port, host = '0.0.0.0', logger, shutdownTimeoutMs = 10_000 } = options
  let shuttingDown = false

  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down gracefully')

    const deadline = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit')
      process.exit(1)
    }, shutdownTimeoutMs)
    deadline.unref()

    try {
      await app.close()
      logger.info('shutdown complete')
      process.exit(exitCode)
    } catch (err) {
      logger.error({ err }, 'error during shutdown')
      process.exit(1)
    }
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection')
    void shutdown('unhandledRejection', 1)
  })

  await app.listen({ port, host })
}
