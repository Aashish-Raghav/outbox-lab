import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { EMAIL_STATUS } from '@reachinbox/shared';
import { env } from '../../src/config/env.js';
import { createServer } from '../../src/server.js';
import { prisma, disconnectDatabase } from '../../src/lib/prisma.js';
import { disconnectRedis } from '../../src/lib/redis.js';
import { closeQueue, emailQueue } from '../../src/queue/emailQueue.js';
import { createSender, createUser, resetAll } from '../helpers.js';

/**
 * The HTTP surface, exercised through the real middleware stack.
 *
 * `createServer()` returns an app rather than a listening server precisely so
 * this can run without binding a port — the auth, validation, error-handling and
 * rate-limit middleware are all the same objects production uses.
 */

let app: Express;

beforeAll(() => {
  app = createServer();
});

beforeEach(resetAll);

afterAll(async () => {
  await resetAll();
  await closeQueue();
  await disconnectDatabase();
  await disconnectRedis();
});

/** Logs in through the demo path and returns the session cookie header. */
async function login(): Promise<string[]> {
  const response = await request(app)
    .post('/api/auth/password')
    .send({ email: env.DEMO_USER_EMAIL, password: env.DEMO_USER_PASSWORD })
    .expect(200);

  const cookies = response.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies : [cookies as unknown as string];
}

describe('GET /api/health', () => {
  it('reports dependency health without requiring auth', async () => {
    // Container probes must never need a credential.
    const response = await request(app).get('/api/health').expect(200);

    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.checks.database).toBe(true);
    expect(response.body.data.checks.redis).toBe(true);
  });

  it('echoes the tuning knobs so a deployment is self-documenting', async () => {
    const { body } = await request(app).get('/api/health').expect(200);

    expect(body.data.config).toMatchObject({
      workerConcurrency: env.WORKER_CONCURRENCY,
      minDelayBetweenSendsMs: env.MIN_DELAY_BETWEEN_SENDS_MS,
      maxEmailsPerHour: env.MAX_EMAILS_PER_HOUR,
      maxEmailsPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    });
  });
});

describe('auth', () => {
  it('tells the login page which methods are actually available', async () => {
    const { body } = await request(app).get('/api/auth/config').expect(200);

    expect(body.data.passwordLoginEnabled).toBe(true);
    expect(body.data).toHaveProperty('googleEnabled');
  });

  it('rejects a wrong password', async () => {
    const response = await request(app)
      .post('/api/auth/password')
      .send({ email: env.DEMO_USER_EMAIL, password: 'wrong' })
      .expect(401);

    expect(response.body.error.message).toMatch(/incorrect/i);
  });

  it('issues an httpOnly session cookie', async () => {
    const [cookie] = await login();

    // The token must be unreachable from JavaScript, or an XSS in the dashboard
    // becomes a full session takeover.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite/i);
  });

  it('returns the signed-in user from /me', async () => {
    const cookies = await login();
    const { body } = await request(app).get('/api/auth/me').set('Cookie', cookies).expect(200);

    expect(body.data.user.email).toBe(env.DEMO_USER_EMAIL);
    // Nothing secret leaks into the profile payload.
    expect(body.data.user).not.toHaveProperty('password');
  });

  it('refuses /me without a cookie', async () => {
    await request(app).get('/api/auth/me').expect(401);
  });

  it('refuses a forged token', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Cookie', ['reachinbox_session=not.a.real.token'])
      .expect(401);
  });

  it('clears the cookie on logout', async () => {
    const cookies = await login();
    const response = await request(app).post('/api/auth/logout').set('Cookie', cookies).expect(200);

    const cleared = response.headers['set-cookie']![0]!;
    expect(cleared).toMatch(/reachinbox_session=;|reachinbox_session=;/);
  });

  it('rejects a malformed body with a field-level error', async () => {
    const response = await request(app)
      .post('/api/auth/password')
      .send({ email: 'not-an-email' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    // Keyed by field path, so the compose form can highlight the offending input
    // rather than showing one generic banner.
    expect(response.body.error.details).toHaveProperty('password');
  });
});

describe('protected routes', () => {
  it('require a session', async () => {
    for (const path of ['/api/senders', '/api/campaigns', '/api/emails', '/api/stats']) {
      await request(app).get(path).expect(401);
    }
  });
});

describe('GET /api/senders', () => {
  it('returns quota usage and never the SMTP credentials', async () => {
    const cookies = await login();
    await createSender({ name: 'Mailbox One', maxEmailsPerHour: 25 });

    const { body } = await request(app).get('/api/senders').set('Cookie', cookies).expect(200);

    expect(body.data).toHaveLength(1);
    const [sender] = body.data;

    expect(sender).toMatchObject({
      name: 'Mailbox One',
      isActive: true,
      usedThisHour: 0,
      limitThisHour: 25,
    });
    // A leaked SMTP password is a leaked mailbox.
    expect(sender).not.toHaveProperty('smtpPass');
    expect(sender).not.toHaveProperty('smtpUser');
    expect(sender).not.toHaveProperty('smtpHost');
  });
});

describe('POST /api/campaigns', () => {
  it('schedules a campaign from typed recipients', async () => {
    const cookies = await login();
    const sender = await createSender();
    const startAt = new Date(Date.now() + 3_600_000).toISOString();

    const { body } = await request(app)
      .post('/api/campaigns')
      .set('Cookie', cookies)
      .field('senderId', sender.id)
      .field('subject', 'Hello there')
      .field('bodyHtml', '<p>Body text</p>')
      .field('recipients', 'alice@example.com, bob@example.com')
      .field('startAt', startAt)
      // The Figma field is "Delay between 2 emails" in seconds; the API keeps
      // that unit and converts to milliseconds internally.
      .field('delayBetweenSeconds', '5')
      .field('hourlyLimit', '0')
      .expect(201);

    expect(body.data).toMatchObject({
      recipientsAccepted: 2,
      duplicatesRemoved: 0,
      invalidSkipped: [],
      windowsRequired: 1,
      throttledByHourlyLimit: false,
    });
    expect(body.data.campaign).toMatchObject({ totalRecipients: 2, delayBetweenMs: 5000 });

    const rows = await prisma.emailJob.findMany({
      where: { campaignId: body.data.campaign.id },
      orderBy: { seq: 'asc' },
    });
    expect(rows[1]!.scheduledAt.getTime() - rows[0]!.scheduledAt.getTime()).toBe(5000);
    expect(rows.map((row) => row.toEmail)).toEqual(['alice@example.com', 'bob@example.com']);
    // Queued for the future, not sent on the spot.
    expect(rows.every((row) => row.status === EMAIL_STATUS.SCHEDULED)).toBe(true);
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(2);
  });

  it('parses an uploaded CSV and reports what it detected', async () => {
    const cookies = await login();
    const sender = await createSender();

    const csv = [
      'first_name,email',
      'Alice,alice@example.com',
      'Bob,bob@example.com',
      'Alice again,ALICE@example.com',
      'Broken,,',
    ].join('\n');

    const { body } = await request(app)
      .post('/api/campaigns')
      .set('Cookie', cookies)
      .field('senderId', sender.id)
      .field('subject', 'From a list')
      .field('bodyHtml', '<p>Body</p>')
      .field('delayBetweenSeconds', '0')
      .field('hourlyLimit', '0')
      .attach('leads', Buffer.from(csv), { filename: 'leads.csv', contentType: 'text/csv' })
      .expect(201);

    // The compose screen shows these numbers back to the user, so they have to
    // be right or the upload silently lies about its own contents.
    expect(body.data.recipientsAccepted).toBe(2);
    expect(body.data.duplicatesRemoved).toBe(1);
    // The row with no address is reported so the user can go fix their file...
    expect(body.data.invalidSkipped).toEqual(['Broken,,']);
    // ...but the header row is a normal part of an export, not a broken line,
    // and must not be reported on every well-formed upload.
    expect(body.data.invalidSkipped).not.toContain('first_name,email');
  });

  it('merges typed and uploaded recipients without double-counting', async () => {
    const cookies = await login();
    const sender = await createSender();

    const { body } = await request(app)
      .post('/api/campaigns')
      .set('Cookie', cookies)
      .field('senderId', sender.id)
      .field('subject', 'Merged')
      .field('bodyHtml', '<p>Body</p>')
      .field('recipients', 'alice@example.com')
      .field('delayBetweenSeconds', '0')
      .field('hourlyLimit', '0')
      .attach('leads', Buffer.from('ALICE@example.com\nbob@example.com'), {
        filename: 'leads.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    expect(body.data.recipientsAccepted).toBe(2);
    expect(body.data.duplicatesRemoved).toBe(1);
  });

  it('rejects a campaign with no recipients at all', async () => {
    const cookies = await login();
    const sender = await createSender();

    const response = await request(app)
      .post('/api/campaigns')
      .set('Cookie', cookies)
      .field('senderId', sender.id)
      .field('subject', 'Nobody')
      .field('bodyHtml', '<p>Body</p>')
      .field('delayBetweenSeconds', '0')
      .field('hourlyLimit', '0')
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('404s on an unknown sender rather than 500ing', async () => {
    const cookies = await login();

    await request(app)
      .post('/api/campaigns')
      .set('Cookie', cookies)
      .field('senderId', '00000000-0000-0000-0000-000000000000')
      .field('subject', 'Ghost')
      .field('bodyHtml', '<p>Body</p>')
      .field('recipients', 'a@example.com')
      .field('delayBetweenSeconds', '0')
      .field('hourlyLimit', '0')
      .expect(404);
  });
});

describe('GET /api/emails', () => {
  async function seedMailbox(cookies: string[]) {
    const sender = await createSender();
    const { body } = await request(app)
      .post('/api/campaigns')
      .set('Cookie', cookies)
      .field('senderId', sender.id)
      .field('subject', 'Quarterly update')
      .field('bodyHtml', '<p>The body of the message.</p>')
      .field('recipients', 'alice@example.com,bob@example.com,carol@example.com')
      .field('startAt', new Date(Date.now() + 3_600_000).toISOString())
      .field('delayBetweenSeconds', '1000')
      .field('hourlyLimit', '0')
      .expect(201);

    return body.data.campaign.id as string;
  }

  it('lists the scheduled mailbox soonest-first', async () => {
    const cookies = await login();
    await seedMailbox(cookies);

    const { body } = await request(app)
      .get('/api/emails?mailbox=scheduled')
      .set('Cookie', cookies)
      .expect(200);

    expect(body.data.items).toHaveLength(3);
    const times = body.data.items.map((item: { scheduledAt: string }) =>
      Date.parse(item.scheduledAt),
    );
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // The list row renders subject + snippet; the snippet is derived server-side
    // so the client never has to sanitise HTML itself.
    expect(body.data.items[0].preview).toBe('The body of the message.');
  });

  it('keeps the sent mailbox empty until something is actually sent', async () => {
    const cookies = await login();
    await seedMailbox(cookies);

    const { body } = await request(app)
      .get('/api/emails?mailbox=sent')
      .set('Cookie', cookies)
      .expect(200);

    expect(body.data.items).toEqual([]);
    expect(body.data.pagination.total).toBe(0);
  });

  it('searches on recipient and subject', async () => {
    const cookies = await login();
    await seedMailbox(cookies);

    const byRecipient = await request(app)
      .get('/api/emails?search=CAROL')
      .set('Cookie', cookies)
      .expect(200);
    // Case-insensitive: nobody types the exact casing of an address.
    expect(byRecipient.body.data.items).toHaveLength(1);

    const bySubject = await request(app)
      .get('/api/emails?search=quarterly')
      .set('Cookie', cookies)
      .expect(200);
    expect(bySubject.body.data.items).toHaveLength(3);
  });

  it('paginates', async () => {
    const cookies = await login();
    await seedMailbox(cookies);

    const { body } = await request(app)
      .get('/api/emails?page=1&limit=2')
      .set('Cookie', cookies)
      .expect(200);

    expect(body.data.items).toHaveLength(2);
    expect(body.data.pagination).toMatchObject({ total: 3, totalPages: 2, hasNext: true });
  });

  it('rejects an out-of-range limit instead of trying to serve it', async () => {
    const cookies = await login();
    await request(app).get('/api/emails?limit=100000').set('Cookie', cookies).expect(400);
  });

  it('never returns another user\'s emails', async () => {
    const cookies = await login();
    await seedMailbox(cookies);

    // A campaign owned by somebody else entirely.
    const stranger = await createUser();
    const strangerSender = await createSender();
    await prisma.campaign.create({
      data: {
        userId: stranger.id,
        senderId: strangerSender.id,
        subject: 'Not yours',
        bodyHtml: '<p>x</p>',
        startAt: new Date(),
        delayBetweenMs: 0,
        totalRecipients: 1,
        emailJobs: {
          create: {
            userId: stranger.id,
            senderId: strangerSender.id,
            toEmail: 'stranger@example.com',
            subject: 'Not yours',
            bodyHtml: '<p>x</p>',
            seq: 0,
            scheduledAt: new Date(),
          },
        },
      },
    });

    const { body } = await request(app).get('/api/emails').set('Cookie', cookies).expect(200);
    expect(body.data.pagination.total).toBe(3);
    expect(
      body.data.items.some((item: { toEmail: string }) => item.toEmail === 'stranger@example.com'),
    ).toBe(false);
  });
});

describe('single email actions', () => {
  async function seedOne(cookies: string[]) {
    const sender = await createSender();
    const { body } = await request(app)
      .post('/api/campaigns')
      .set('Cookie', cookies)
      .field('senderId', sender.id)
      .field('subject', 'One email')
      .field('bodyHtml', '<p>Body</p>')
      .field('recipients', 'solo@example.com')
      .field('startAt', new Date(Date.now() + 3_600_000).toISOString())
      .field('delayBetweenSeconds', '0')
      .field('hourlyLimit', '0')
      .expect(201);

    const row = await prisma.emailJob.findFirstOrThrow({
      where: { campaignId: body.data.campaign.id },
    });
    return row.id;
  }

  it('returns the detail view with the full body', async () => {
    const cookies = await login();
    const id = await seedOne(cookies);

    const { body } = await request(app).get(`/api/emails/${id}`).set('Cookie', cookies).expect(200);

    expect(body.data.bodyHtml).toContain('Body');
    expect(body.data.attachments).toEqual([]);
  });

  it('404s for an id belonging to nobody', async () => {
    const cookies = await login();
    await request(app)
      .get('/api/emails/00000000-0000-0000-0000-000000000000')
      .set('Cookie', cookies)
      .expect(404);
  });

  it('cancels a scheduled email and removes its queue job', async () => {
    const cookies = await login();
    const id = await seedOne(cookies);

    await request(app).post(`/api/emails/${id}/cancel`).set('Cookie', cookies).expect(200);

    const row = await prisma.emailJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(EMAIL_STATUS.CANCELLED);
    // Removed from Redis too, so it cannot wake up later.
    expect(await emailQueue.getJob(id)).toBeUndefined();
  });

  it('refuses to cancel something already sent', async () => {
    const cookies = await login();
    const id = await seedOne(cookies);
    await prisma.emailJob.update({
      where: { id },
      data: { status: EMAIL_STATUS.SENT, sentAt: new Date() },
    });

    await request(app).post(`/api/emails/${id}/cancel`).set('Cookie', cookies).expect(400);
  });

  it('toggles the star', async () => {
    const cookies = await login();
    const id = await seedOne(cookies);

    await request(app)
      .patch(`/api/emails/${id}/star`)
      .set('Cookie', cookies)
      .send({ isStarred: true })
      .expect(200);

    expect((await prisma.emailJob.findUniqueOrThrow({ where: { id } })).isStarred).toBe(true);
  });
});

describe('GET /api/stats', () => {
  it('produces the sidebar counts', async () => {
    const cookies = await login();
    const sender = await createSender();

    const { body: created } = await request(app)
      .post('/api/campaigns')
      .set('Cookie', cookies)
      .field('senderId', sender.id)
      .field('subject', 'Counting')
      .field('bodyHtml', '<p>Body</p>')
      .field('recipients', 'a@example.com,b@example.com,c@example.com')
      .field('startAt', new Date(Date.now() + 3_600_000).toISOString())
      .field('delayBetweenSeconds', '0')
      .field('hourlyLimit', '0')
      .expect(201);

    await prisma.emailJob.updateMany({
      where: { campaignId: created.data.campaign.id, toEmail: 'a@example.com' },
      data: { status: EMAIL_STATUS.SENT, sentAt: new Date() },
    });

    const { body } = await request(app).get('/api/stats').set('Cookie', cookies).expect(200);

    expect(body.data).toMatchObject({ scheduled: 2, sent: 1 });
  });
});

describe('error handling', () => {
  it('404s an unknown route in the standard envelope', async () => {
    const { body } = await request(app).get('/api/nope').expect(404);
    expect(body.error.code).toBeTruthy();
    expect(body.error.message).toBeTruthy();
  });

  it('attaches a request id to every response for log correlation', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});
