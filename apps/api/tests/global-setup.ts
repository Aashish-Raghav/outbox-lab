import { execFileSync } from 'node:child_process';

/**
 * Brings the throwaway test database up to the current schema once per run.
 *
 * `migrate deploy` rather than `db push` so the suite exercises the same
 * migrations that would be applied in production — a migration that is broken
 * in CI should fail here, not in a deploy.
 */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');

  if (!/test/i.test(url)) {
    // The suite truncates every table between tests. Refuse to point that at a
    // database whose name does not clearly mark it as disposable.
    throw new Error(
      `Refusing to run destructive tests against "${url}" — the database name must contain "test".`,
    );
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
