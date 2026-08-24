/**
 * End-to-end verification against a running API.
 *
 * Exercises the real HTTP surface — login, sender listing, a multipart compose
 * with an uploaded lead list, then polling the dashboard endpoints until every
 * email reaches a terminal state — and finally checks the database's audit
 * trail directly to prove the properties the assignment asks for:
 *
 *   • every email was delivered (real Ethereal preview URL present)
 *   • no email was sent twice (exactly one SENT event per job)
 *   • duplicates in the uploaded list were collapsed, invalid lines skipped
 *   • the configured minimum gap between sends was actually honoured
 *
 * Usage:
 *   npm run e2e                 # against http://localhost:4000
 *   npm run e2e -- --count 5 --api http://localhost:4000
 */

import { EMAIL_STATUS } from '@reachinbox/shared';
import { env } from '../apps/api/src/config/env.js';
import { prisma, disconnectDatabase } from '../apps/api/src/lib/prisma.js';

interface Options {
  api: string;
  count: number;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    api: process.env.E2E_API_URL ?? `http://localhost:${env.PORT}`,
    count: 4,
    timeoutMs: 180_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === '--api' && next) options.api = next;
    if (argv[i] === '--count' && next) options.count = Number.parseInt(next, 10);
    if (argv[i] === '--timeout' && next) options.timeoutMs = Number.parseInt(next, 10) * 1000;
  }

  return options;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (!ok) failures += 1;
  const mark = ok ? '[32m✓[0m' : '[31m✗[0m';
  console.log(`  ${mark} ${label}${detail ? `  [90m${detail}[0m` : ''}`);
}

/**
 * Minimal cookie-jar fetch. The session is an httpOnly cookie, so the script
 * has to carry it the same way a browser would.
 */
function createClient(baseUrl: string) {
  let cookie = '';

  return async function call(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
    });

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    return { status: response.status, body };
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const call = createClient(options.api);

  console.log(`\nReachInbox e2e — ${options.api}\n`);

  // ── 1. The service is up ───────────────────────────────────────────────────
  console.log('health');
  const health = await call('/api/health');
  check('API reachable', health.status === 200, `status ${health.status}`);
  check('database connected', health.body?.data?.checks?.database === true);
  check('redis connected', health.body?.data?.checks?.redis === true);

  if (health.status !== 200) {
    throw new Error('API is not healthy — start it with `npm run dev` first.');
  }

  const minDelayMs: number = health.body.data.config.minDelayBetweenSendsMs;

  // ── 2. Authentication ──────────────────────────────────────────────────────
  console.log('\nauth');
  const login = await call('/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: env.DEMO_USER_EMAIL,
      password: env.DEMO_USER_PASSWORD,
    }),
  });
  check('demo login succeeds', login.status === 200, `status ${login.status}`);

  const me = await call('/api/auth/me');
  check('session cookie is accepted', me.status === 200);

  const unauth = await fetch(`${options.api}/api/emails`);
  check('unauthenticated request is rejected', unauth.status === 401, `status ${unauth.status}`);

  // ── 3. Senders ─────────────────────────────────────────────────────────────
  console.log('\nsenders');
  const senders = await call('/api/senders');
  const senderList: any[] = senders.body?.data ?? [];
  check('at least one active sender', senderList.length > 0, `${senderList.length} found`);
  check(
    'SMTP credentials are not exposed',
    senderList.every((sender) => !('smtpPass' in sender) && !('smtpUser' in sender)),
  );

  if (senderList.length === 0) {
    throw new Error('No senders. Run `npm run provision:ethereal` first.');
  }
  const sender = senderList[0];

  // ── 4. Schedule a campaign through the real compose endpoint ───────────────
  console.log('\ncompose');

  // Deliberately messy: a duplicate, a malformed line, and mixed casing — the
  // parser is supposed to sort all three out.
  const stamp = Date.now();
  const addresses = Array.from(
    { length: options.count },
    (_, i) => `e2e-${stamp}-${i}@example.com`,
  );
  const csv = [
    'email,first_name',
    ...addresses.map((address, i) => `${address},Person ${i}`),
    `${addresses[0]!.toUpperCase()},Duplicate`,
    'definitely not an email,Broken',
    '',
  ].join('\n');

  const form = new FormData();
  form.set('senderId', sender.id);
  form.set('subject', `ReachInbox e2e ${stamp}`);
  form.set('bodyHtml', '<p>Automated end-to-end check. <b>Please ignore.</b></p>');
  form.set('delayBetweenSeconds', '0');
  form.set('hourlyLimit', '0');
  form.set('leads', new Blob([csv], { type: 'text/csv' }), 'leads.csv');

  const created = await call('/api/campaigns', { method: 'POST', body: form });
  check('campaign accepted', created.status === 201, `status ${created.status}`);

  if (created.status !== 201) {
    console.error(JSON.stringify(created.body, null, 2));
    throw new Error('Campaign creation failed');
  }

  const result = created.body.data;
  check(
    `detected ${options.count} addresses`,
    result.recipientsAccepted === options.count,
    `got ${result.recipientsAccepted}`,
  );
  check('duplicate collapsed', result.duplicatesRemoved >= 1, `${result.duplicatesRemoved} removed`);
  check(
    'malformed line skipped',
    result.invalidSkipped.length >= 1,
    JSON.stringify(result.invalidSkipped),
  );

  const campaignId: string = result.campaign.id;

  // ── 5. Wait for delivery ───────────────────────────────────────────────────
  console.log('\ndelivery');
  const deadline = Date.now() + options.timeoutMs;
  let rows: Array<{ status: string; previewUrl: string | null; sentAt: Date | null }> = [];

  for (;;) {
    rows = await prisma.emailJob.findMany({
      where: { campaignId },
      select: { status: true, previewUrl: true, sentAt: true },
    });

    const pending = rows.filter(
      (row) =>
        row.status !== EMAIL_STATUS.SENT &&
        row.status !== EMAIL_STATUS.FAILED &&
        row.status !== EMAIL_STATUS.CANCELLED,
    );

    if (pending.length === 0 && rows.length > 0) break;

    if (Date.now() > deadline) {
      check('all emails reached a terminal state', false, `${pending.length} still pending`);
      break;
    }

    process.stdout.write(
      `\r  waiting… ${rows.filter((r) => r.status === EMAIL_STATUS.SENT).length}/${rows.length} sent`,
    );
    await sleep(1500);
  }
  process.stdout.write('\r[K');

  const sent = rows.filter((row) => row.status === EMAIL_STATUS.SENT);
  check('every email was sent', sent.length === rows.length, `${sent.length}/${rows.length}`);
  check(
    'every send has an Ethereal preview URL',
    sent.length > 0 && sent.every((row) => Boolean(row.previewUrl)),
  );

  // ── 6. Idempotency, proven from the audit trail ────────────────────────────
  console.log('\nidempotency');
  const sentEvents = await prisma.emailEvent.groupBy({
    by: ['emailJobId'],
    where: { status: EMAIL_STATUS.SENT, emailJob: { campaignId } },
    _count: { _all: true },
  });

  const doubled = sentEvents.filter((event) => event._count._all > 1);
  check(
    'no email has more than one SENT event',
    doubled.length === 0,
    doubled.length > 0 ? `${doubled.length} duplicated!` : `${sentEvents.length} jobs, 1 each`,
  );

  // ── 7. Pacing ──────────────────────────────────────────────────────────────
  //
  // Measured from the PROCESSING events, not from `sentAt`. The limiter paces
  // when a send *starts*; `sentAt` is stamped after the SMTP round-trip, and
  // the first message of a batch pays TCP + TLS + AUTH (~1.5s) while later ones
  // reuse the pooled connection (~50ms). Comparing completion times would make
  // correctly-paced sends look 800ms apart.
  console.log('\npacing');
  const starts = await prisma.emailEvent.findMany({
    where: { status: EMAIL_STATUS.PROCESSING, emailJob: { campaignId } },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (starts.length >= 2 && minDelayMs > 0) {
    const times = starts.map((event) => event.createdAt.getTime());
    const gaps = times.slice(1).map((time, i) => time - times[i]!);
    const smallest = Math.min(...gaps);
    // Tolerance covers Redis TTL granularity, not real slippage.
    check(
      `sends start at least ${minDelayMs}ms apart`,
      smallest >= minDelayMs - 100,
      `smallest gap ${smallest}ms, all gaps [${gaps.join(', ')}]`,
    );
  } else {
    console.log('  [90m- skipped (needs 2+ sends and MIN_DELAY_BETWEEN_SENDS_MS > 0)[0m');
  }

  // ── 8. The dashboard endpoints reflect all of it ───────────────────────────
  console.log('\ndashboard');
  const sentBox = await call(`/api/emails?mailbox=sent&search=${encodeURIComponent(String(stamp))}`);
  check(
    'Sent tab lists the campaign',
    sentBox.body?.data?.items?.length === options.count,
    `${sentBox.body?.data?.items?.length} rows`,
  );

  const stats = await call('/api/stats');
  check('stats endpoint responds', stats.status === 200);
  check('sentThisHour is counted', (stats.body?.data?.sentThisHour ?? 0) >= sent.length);

  const firstPreview = sent.find((row) => row.previewUrl)?.previewUrl;
  if (firstPreview) console.log(`\n  Inspect a delivered message: ${firstPreview}`);

  console.log(
    `\n${failures === 0 ? '[32mPASS[0m' : '[31mFAIL[0m'} — ` +
      `${checks - failures}/${checks} checks passed\n`,
  );

  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('\ne2e failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
