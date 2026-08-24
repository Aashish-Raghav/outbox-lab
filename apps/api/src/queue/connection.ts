import type { ConnectionOptions } from 'bullmq';
import { createRedisConnection } from '../lib/redis.js';
import { env } from '../config/env.js';

/**
 * BullMQ connection wiring.
 *
 * Producers and consumers get *separate* Redis connections on purpose: a Worker
 * issues blocking commands (BRPOPLPUSH) that would otherwise stall unrelated
 * queue calls made from request handlers on the same socket.
 */

let queueConnection: ConnectionOptions | null = null;

/** Lazily created shared connection for Queue / QueueEvents instances. */
export function getQueueConnection(): ConnectionOptions {
  if (!queueConnection) {
    queueConnection = createRedisConnection('queue') as unknown as ConnectionOptions;
  }
  return queueConnection;
}

/** A dedicated connection for a Worker, which must not be shared. */
export function createWorkerConnection(): ConnectionOptions {
  return createRedisConnection('worker') as unknown as ConnectionOptions;
}

/**
 * Namespaces every Redis key BullMQ writes. Lets the test suite and a dev
 * instance share one Redis server without colliding.
 */
export const queuePrefix = env.QUEUE_PREFIX;
