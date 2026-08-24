/**
 * Idempotent development seed.
 *
 * Creates the demo user so the dashboard can be opened immediately, and — if no
 * senders exist yet — provisions one real Ethereal inbox so a campaign can be
 * scheduled without any extra setup. Run `npm run provision:ethereal -- --count 3`
 * for the multi-sender rate-limiting demo.
 *
 * Safe to re-run: every write is an upsert.
 */

import { env } from '../src/config/env.js';
import { prisma, disconnectDatabase } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { createEtherealAccount } from '../src/mail/ethereal.js';

const log = logger.child({ scope: 'seed' });

async function main(): Promise<void> {
  const email = env.DEMO_USER_EMAIL.toLowerCase();

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: 'Demo User', avatarUrl: null },
  });
  log.info({ userId: user.id, email: user.email }, 'demo user ready');

  const activeSenders = await prisma.sender.count({ where: { isActive: true } });

  if (activeSenders > 0) {
    log.info({ activeSenders }, 'senders already present, leaving them alone');
  } else {
    log.info('no senders found, provisioning one Ethereal account');

    const account = await createEtherealAccount();
    const sender = await prisma.sender.upsert({
      where: { fromEmail: account.user },
      update: { smtpPass: account.pass, isActive: true },
      create: {
        name: 'Amanda Clark',
        fromEmail: account.user,
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        smtpSecure: account.smtp.secure,
        smtpUser: account.user,
        smtpPass: account.pass,
        isActive: true,
        maxEmailsPerHour: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      },
    });

    log.info({ fromEmail: sender.fromEmail }, 'ethereal sender seeded');
    console.log(`\nEthereal inbox: https://ethereal.email/login`);
    console.log(`  user: ${account.user}`);
    console.log(`  pass: ${account.pass}\n`);
  }

  if (env.ALLOW_PASSWORD_LOGIN) {
    console.log(`Sign in at http://localhost:3000/login`);
    console.log(`  email:    ${email}`);
    console.log(`  password: ${env.DEMO_USER_PASSWORD}\n`);
  }
}

main()
  .catch((error: unknown) => {
    log.error({ err: error }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
