import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Environment contract.
 *
 * Parsed once, at import time, and the process refuses to start if anything is
 * missing or malformed. A scheduler that boots with a silently-defaulted rate
 * limit is worse than one that does not boot at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

/**
 * Loads a .env file into `process.env` without pulling in dotenv.
 * Values already present in the real environment always win, so
 * `MAX_EMAILS_PER_HOUR=5 npm run dev` overrides the file as expected.
 */
function loadEnvFile(file: string): void {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;

    const key = match[1]!;
    if (process.env[key] !== undefined) continue;

    let value = match[2]!;
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    process.env[key] = value;
  }
}

// The monorepo keeps a single .env at the root so the API, the worker and the
// scripts cannot drift apart.
const rootEnvFile = path.join(repoRoot, '.env');
if (existsSync(rootEnvFile) && !process.env.REACHINBOX_ENV_LOADED) {
  loadEnvFile(rootEnvFile);
  process.env.REACHINBOX_ENV_LOADED = '1';
}

/** Accepts `true/false/1/0/yes/no`, so the .env stays forgiving. */
const booleanish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    TEST_DATABASE_URL: z.string().optional(),

    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
    QUEUE_PREFIX: z.string().default('reachinbox'),

    /**
     * Run the send worker inside the API process. Convenient for local dev and
     * for the reviewer (one command boots everything); a real deployment sets
     * this to false and scales `npm run start:worker` independently.
     */
    RUN_WORKER_IN_API: booleanish(true),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(5),
    MIN_DELAY_BETWEEN_SENDS_MS: z.coerce.number().int().min(0).max(3_600_000).default(2000),
    MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    RETRY_BACKOFF_MS: z.coerce.number().int().min(100).default(5000),

    MAX_EMAILS_PER_HOUR: z.coerce.number().int().min(1).default(200),
    MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).default(100),
    MAX_RESCHEDULES: z.coerce.number().int().min(1).max(8760).default(48),
    RATE_LIMIT_REFUND_ON_FAILURE: booleanish(false),
    SENDER_FAILOVER: booleanish(false),

    STALE_LOCK_MS: z.coerce.number().int().min(1000).default(300_000),
    RESEND_SUSPECT_JOBS: booleanish(false),
    /** 0 disables the secondary repair sweep entirely. */
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),

    GOOGLE_CLIENT_ID: z.string().default(''),
    JWT_SECRET: z.string().min(8, 'JWT_SECRET must be at least 8 characters'),
    JWT_EXPIRES_IN: z.string().default('7d'),
    ALLOW_PASSWORD_LOGIN: booleanish(false),
    DEMO_USER_EMAIL: z.string().default('demo@reachinbox.ai'),
    DEMO_USER_PASSWORD: z.string().default('demo1234'),

    ETHEREAL_SENDER_COUNT: z.coerce.number().int().min(1).max(20).default(3),
    MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(5_242_880),
    MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().min(1).default(5000),
    UPLOAD_DIR: z.string().default('./uploads'),
  })
  .superRefine((value, ctx) => {
    // A production deployment must not fall back to the demo credentials or a
    // development signing key.
    if (value.NODE_ENV !== 'production') return;

    if (value.ALLOW_PASSWORD_LOGIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOW_PASSWORD_LOGIN'],
        message: 'The demo password login cannot be enabled in production.',
      });
    }
    if (value.JWT_SECRET.includes('dev-only') || value.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'Set a dedicated JWT_SECRET of at least 32 characters in production.',
      });
    }
    if (value.GOOGLE_CLIENT_ID === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_CLIENT_ID'],
        message: 'GOOGLE_CLIENT_ID is required in production.',
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Thrown before the logger exists, so this writes directly to stderr.
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  console.error('Copy .env.example to .env and fill in the missing values.\n');
  process.exit(1);
}

export const env = parsed.data;

export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Absolute path uploads are written to; created lazily on first write. */
export const uploadDir = path.isAbsolute(env.UPLOAD_DIR)
  ? env.UPLOAD_DIR
  : path.resolve(repoRoot, env.UPLOAD_DIR);

/**
 * Google login is only wired up once a client id exists. The dashboard asks the
 * API for this so it can render the right login affordances instead of showing
 * a Google button that cannot possibly work.
 */
export const isGoogleAuthConfigured = env.GOOGLE_CLIENT_ID.trim() !== '';

export { repoRoot };
