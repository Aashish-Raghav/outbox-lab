import type { Server } from 'node:http';
import type { Worker } from 'bullmq';
import { logger } from './logger.js';
import { toMessage } from './errors.js';
import { disconnectDatabase } from './prisma.js';
import { disconnectRedis } from './redis.js';
import { closeQueue } from '../queue/emailQueue.js';
import { stopQueueEvents } from '../queue/events.js';
import { stopReconcileSweep } from '../scheduler/reconciler.js';
import { closeAllTransports } from '../mail/transport.js';

/**
 * Graceful shutdown, shared by the API and the worker-only entrypoint.
 *
 * Lives in its own module rather than in `index.ts` so `worker.ts` can reuse it
 * without importing — and therefore executing — the API's bootstrap.
 *
 * The ordering is what makes "nothing is sent twice across a restart" true: the
 * worker is closed *before* the connections it depends on, so an in-flight send
 * finishes and commits its SENT row instead of being killed mid-transaction and
 * left in the ambiguous PROCESSING state that the reconciler has to guess about.
 */
export function registerShutdown(handles: { server?: Server; worker?: Worker | null }): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second Ctrl-C must not start a competing teardown.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');

    // Backstop: a hung SMTP socket must not block the exit forever.
    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out after 20s, forcing exit');
      process.exit(1);
    }, 20_000);
    forceExit.unref();

    try {
      stopReconcileSweep();

      // Stop accepting new HTTP work first, so nothing new is scheduled while
      // the queue machinery is being torn down.
      await new Promise<void>((resolve) => {
        if (!handles.server) return resolve();
        handles.server.close(() => resolve());
      });

      // `false` = let active jobs finish rather than abandoning them mid-send.
      if (handles.worker) await handles.worker.close(false);

      await stopQueueEvents();
      await closeQueue();
      await closeAllTransports();
      await disconnectDatabase();
      await disconnectRedis();

      logger.info('shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: toMessage(error) }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: toMessage(reason) }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    // The process is now in an unknown state; the only safe move is to exit and
    // let the supervisor restart us. The boot reconciler resumes the schedule.
    logger.fatal({ err: error }, 'uncaught exception, exiting');
    process.exit(1);
  });
}
