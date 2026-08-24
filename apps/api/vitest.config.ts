import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The integration suite runs against **real** Redis and Postgres rather than
 * mocks. The properties being tested — atomic reservation across concurrent
 * clients, a conditional UPDATE resolving a claim race, delayed jobs surviving
 * a FLUSHALL — are properties of those systems. A mock would only assert that
 * the mock behaves as imagined.
 */

const repoRoot = path.resolve(__dirname, '../..');

/** Reads the root .env directly; config/env.ts has not been imported yet. */
function fromEnvFile(key: string): string | undefined {
  const file = path.join(repoRoot, '.env');
  if (!existsSync(file)) return undefined;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (match) return match[1]!.replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  fromEnvFile('TEST_DATABASE_URL') ??
  'postgresql://reachinbox:reachinbox@127.0.0.1:5432/reachinbox_test';

// `test.env` only reaches the worker threads, so globalSetup — which runs in
// Vitest's main process — needs this set here.
process.env.TEST_DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Suites share one Redis and one Postgres database and truncate between
    // tests, so they must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Point every Prisma client at the throwaway test database.
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
      REDIS_URL: process.env.REDIS_URL ?? fromEnvFile('REDIS_URL') ?? 'redis://127.0.0.1:6379',
      // A distinct prefix keeps test queues and rate-limit counters completely
      // separate from a dev instance running against the same Redis.
      QUEUE_PREFIX: 'reachinbox_test',

      // Small, explicit limits so quota exhaustion is cheap to reach.
      MAX_EMAILS_PER_HOUR: '10',
      MAX_EMAILS_PER_HOUR_PER_SENDER: '5',
      // No artificial pacing: the suite asserts scheduling logic, not wall time.
      MIN_DELAY_BETWEEN_SENDS_MS: '0',
      WORKER_CONCURRENCY: '4',
      MAX_ATTEMPTS: '3',
      // The reconciler is invoked explicitly; the background sweep would make
      // tests racy and is proven unnecessary by reconciler.test.ts.
      RECONCILE_INTERVAL_MS: '0',

      JWT_SECRET: 'test-only-secret-value',
      ALLOW_PASSWORD_LOGIN: 'true',
      DEMO_USER_EMAIL: 'demo@reachinbox.ai',
      DEMO_USER_PASSWORD: 'demo1234',
    },
  },
});
