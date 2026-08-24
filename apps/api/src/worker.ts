import { logger } from './lib/logger.js';
import { connectDatabase } from './lib/prisma.js';
import { checkRedisDurability } from './lib/redis.js';
import { createEmailWorker } from './queue/emailWorker.js';
import { reconcile, startReconcileSweep } from './scheduler/reconciler.js';
import { registerShutdown } from './lib/shutdown.js';

/**
 * Worker-only entrypoint.
 *
 * Run `npm run start:worker` in as many processes as you like: the DB claim and
 * the Redis-backed quota make horizontal scaling safe, so N workers still send
 * each email exactly once and still respect one shared hourly ceiling.
 *
 * Serves no HTTP; it exists so senders can be scaled independently of the API.
 */
async function main(): Promise<void> {
  await connectDatabase();
  await checkRedisDurability();

  // Each worker reconciles at boot. `enqueueIfAbsent` makes this idempotent, so
  // several workers starting at once cannot duplicate the queue.
  const summary = await reconcile();
  logger.info(summary, 'worker startup reconciliation finished');

  const worker = createEmailWorker();
  startReconcileSweep();

  registerShutdown({ worker });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start worker');
  process.exit(1);
});
