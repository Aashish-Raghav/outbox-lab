/**
 * Provisions real Ethereal Email inboxes and seeds them as senders.
 *
 * Ethereal hands out throwaway SMTP accounts on demand, so no credentials ever
 * need to be committed or pasted into .env: run this once and the `senders`
 * table is populated with working, verified SMTP identities.
 *
 * Usage:
 *   npm run provision:ethereal              # uses ETHEREAL_SENDER_COUNT
 *   npm run provision:ethereal -- --count 5
 *   npm run provision:ethereal -- --reset   # deactivate existing senders first
 */

import { env } from '../apps/api/src/config/env.js';
import { prisma, disconnectDatabase } from '../apps/api/src/lib/prisma.js';
import { createEtherealAccount } from '../apps/api/src/mail/ethereal.js';
import { verifyTransport, closeAllTransports } from '../apps/api/src/mail/transport.js';
import { logger } from '../apps/api/src/lib/logger.js';

const log = logger.child({ scope: 'provision' });

function parseArgs(argv: string[]): { count: number; reset: boolean } {
  let count = env.ETHEREAL_SENDER_COUNT;
  let reset = false;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--count' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) count = parsed;
      i += 1;
    }
    if (argv[i] === '--reset') reset = true;
  }

  return { count, reset };
}

/** Human-friendly sender identities, so the dashboard's From dropdown reads well. */
const PERSONAS = [
  'Amanda Clark',
  'Oliver Brown',
  'Priya Nair',
  'Marcus Webb',
  'Sofia Almeida',
  'Daniel Okafor',
  'Hannah Lindqvist',
  'Rahul Menon',
];

async function main(): Promise<void> {
  const { count, reset } = parseArgs(process.argv.slice(2));

  if (reset) {
    const { count: deactivated } = await prisma.sender.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    });
    log.info({ deactivated }, 'deactivated existing senders');
  }

  log.info({ count }, 'requesting Ethereal test accounts');

  const created: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const persona = PERSONAS[i % PERSONAS.length]!;

    // Hits Ethereal's API and returns a live, working SMTP account.
    const account = await createEtherealAccount();

    const sender = await prisma.sender.upsert({
      where: { fromEmail: account.user },
      create: {
        name: persona,
        fromEmail: account.user,
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        smtpSecure: account.smtp.secure,
        smtpUser: account.user,
        smtpPass: account.pass,
        isActive: true,
        maxEmailsPerHour: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      },
      update: {
        smtpPass: account.pass,
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        isActive: true,
      },
    });

    // Prove the credentials actually work now, rather than discovering they do
    // not at the moment the first campaign fires.
    const verification = await verifyTransport(sender);
    if (!verification.ok) {
      log.error({ sender: sender.fromEmail, error: verification.error }, 'SMTP verification failed');
      throw new Error(`Could not verify SMTP for ${sender.fromEmail}: ${verification.error}`);
    }

    created.push(sender.fromEmail);
    log.info(
      { name: persona, fromEmail: sender.fromEmail, hourlyLimit: sender.maxEmailsPerHour },
      'sender provisioned and verified',
    );
  }

  const total = await prisma.sender.count({ where: { isActive: true } });

  log.info({ provisioned: created.length, activeSenders: total }, 'done');
  console.log('\nProvisioned Ethereal senders:');
  for (const email of created) console.log(`  - ${email}`);
  console.log('\nInspect delivered mail at https://ethereal.email/login using any of the');
  console.log('addresses above (the password is stored in the `senders` table).\n');
}

main()
  .catch((error: unknown) => {
    log.error({ err: error }, 'provisioning failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    closeAllTransports();
    await disconnectDatabase();
  });
