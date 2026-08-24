import type { Server } from 'node:http';
import type { Worker } from 'bullmq';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDatabase } from './lib/prisma.js';
import { checkRedisDurability } from './lib/redis.js';
import { registerShutdown } from './lib/shutdown.js';
import { startQueueEvents } from './queue/events.js';
import { createEmailWorker } from './queue/emailWorker.js';
import { reconcile, startReconcileSweep } from './scheduler/reconciler.js';
import { createServer } from './server.js';

/**
 * Combined entrypoint: HTTP API plus, by default, the send worker.
 *
 * Boot order matters. Dependencies are checked first, then the queue is
 * reconciled against the database, and only then does the worker start — so a
 * restart cannot begin sending before the backlog has been rebuilt from
 * Postgres.
 */
async function main(): Promise<void> {
  await connectDatabase();
  await checkRedisDurability();

  const summary = await reconcile();
  logger.info(summary, 'startup reconciliation finished');

  startQueueEvents();

  let worker: Worker | null = null;
  if (env.RUN_WORKER_IN_API) {
    worker = createEmailWorker();
  } else {
    logger.info('RUN_WORKER_IN_API=false — start a worker with `npm run start:worker`');
  }

  startReconcileSweep();

  const app = createServer();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        workerInProcess: env.RUN_WORKER_IN_API,
        corsOrigins: env.CORS_ORIGINS,
      },
      `API listening on http://localhost:${env.PORT}`,
    );
  });

  registerShutdown({ server, worker });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start API');
  process.exit(1);
});
