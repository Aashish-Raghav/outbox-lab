import { QueueEvents } from 'bullmq';
import { EMAIL_QUEUE_NAME } from '@reachinbox/shared';
import { scopedLogger } from '../lib/logger.js';
import { getQueueConnection, queuePrefix } from './connection.js';

const log = scopedLogger('queue:events');

/**
 * Queue-level observability.
 *
 * Intentionally read-only: it logs and counts, but never writes to the
 * database. Job state in Postgres is owned solely by the worker, so there is
 * exactly one writer and no chance of an event listener racing a send.
 */

export interface QueueMetrics {
  completed: number;
  failed: number;
  stalled: number;
  delayed: number;
}

const metrics: QueueMetrics = { completed: 0, failed: 0, stalled: 0, delayed: 0 };

let events: QueueEvents | null = null;

export function startQueueEvents(): QueueEvents {
  if (events) return events;

  events = new QueueEvents(EMAIL_QUEUE_NAME, {
    connection: getQueueConnection(),
    prefix: queuePrefix,
  });

  events.on('completed', () => {
    metrics.completed += 1;
  });

  events.on('failed', ({ jobId, failedReason }) => {
    metrics.failed += 1;
    log.debug({ jobId, failedReason }, 'queue reported job failure');
  });

  events.on('delayed', () => {
    metrics.delayed += 1;
  });

  // A stalled job means a worker died mid-send. Worth surfacing loudly: the
  // database claim makes recovery safe, but it still signals an unhealthy node.
  events.on('stalled', ({ jobId }) => {
    metrics.stalled += 1;
    log.warn({ jobId }, 'job stalled — a worker likely died while processing it');
  });

  log.debug('queue event listener started');
  return events;
}

export function getQueueMetrics(): QueueMetrics {
  return { ...metrics };
}

export async function stopQueueEvents(): Promise<void> {
  await events?.close();
  events = null;
}
