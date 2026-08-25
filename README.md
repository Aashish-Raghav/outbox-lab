# ReachInbox — Email Job Scheduler

A production-shaped email scheduling service and dashboard. You compose an email, upload a
list of leads, pick a start time, a delay between sends and an hourly cap; the backend queues
one job per recipient and delivers them on time, exactly once, across restarts, without a cron
job anywhere in the system.

| | |
|---|---|
| **Backend** | TypeScript · Express · BullMQ + Redis · PostgreSQL (Prisma) · Nodemailer → Ethereal |
| **Frontend** | Next.js 15 (App Router) · React 18 · TypeScript · Tailwind · TanStack Query · Tiptap |
| **Scheduling** | BullMQ delayed jobs. No `node-cron`, no `agenda`, no crontab — see [No cron, anywhere](#no-cron-anywhere) |
| **Tests** | 107 passing across 7 files, against real Redis and real PostgreSQL |

---

## Contents

1. [Quick start](#quick-start)
2. [Ethereal setup](#ethereal-setup)
3. [Google OAuth setup](#google-oauth-setup)
4. [Environment variables](#environment-variables)
5. [Architecture](#architecture)
   · [Scheduling](#scheduling) · [Persistence & restart](#persistence--restart-recovery)
   · [Idempotency](#idempotency-five-independent-layers) · [Rate limiting](#rate-limiting)
   · [Concurrency & min delay](#concurrency--minimum-delay-between-sends)
   · [Behaviour under load](#behaviour-under-load-1000-emails)
6. [No cron, anywhere](#no-cron-anywhere)
7. [Feature list](#feature-list)
8. [Testing & verification](#testing--verification)
9. [Project layout](#project-layout)
10. [Submitting / pushing to GitHub](#pushing-to-github)
11. [Assumptions & trade-offs](#assumptions--trade-offs)

Deeper documents: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/API.md](docs/API.md) · [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) ·
[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) ·
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

**Running live** — dashboard at
<https://reachinbox-web-522727866437.us-central1.run.app>, API health at
<https://reachinbox-api-522727866437.us-central1.run.app/api/health>. Deployed to
Cloud Run; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the topology and the
teardown script.

---

## Quick start

Requires **Node 20+**. Everything else is either a Docker container or two apt packages.

```bash
git clone <this-repo> && cd reachinbox-scheduler
npm install                   # also builds packages/shared and generates the Prisma client
cp .env.example .env
```

`npm install` runs a `prepare` step that builds `@reachinbox/shared` and runs `prisma generate`.
The API resolves the shared package to its built output, so a fresh clone needs both before
anything will start — doing it in `prepare` means you never have to know that.

**1 — Start PostgreSQL and Redis**

```bash
docker compose up -d          # postgres:17 + redis:7 (AOF on, noeviction)
```

No Docker? The same two services from distro packages:

```bash
bash scripts/dev-services.sh install   # apt-get redis-server postgresql-17
bash scripts/dev-services.sh up        # start, enable AOF, create both databases
bash scripts/dev-services.sh status
```

> Redis **must** run with `appendonly yes` and `maxmemory-policy noeviction`. Both paths above
> set them. `noeviction` matters: the default eviction policy would let Redis silently drop a
> scheduled email under memory pressure.

**2 — Migrate the database and mint SMTP senders**

```bash
npm run db:migrate                          # prisma migrate dev
npm run provision:ethereal -- --count 3     # creates 3 real Ethereal inboxes
```

**3 — Run it**

```bash
npm run dev          # API on :4000 (worker in-process) + web on :3000
```

That is `scripts/dev.mjs` — it builds the shared package, then starts the shared watcher, the API
and the dashboard together with prefixed output, and takes the whole set down if any one of them
dies. (`npm run dev --workspaces` cannot do this: it runs workspace scripts in series and would
block forever on the first watcher.)

Or as separate processes, which is how you would deploy it:

```bash
npm run dev:api      # RUN_WORKER_IN_API=false in .env
npm run dev:worker   # scale this one horizontally
npm run dev:web
```

Open **http://localhost:3000**. With no Google credentials configured the login card shows the
demo form; sign in with `demo@reachinbox.ai` / `demo1234` (both from `.env`).

Useful extras:

```bash
npm test                                        # 107 tests, real Redis + Postgres
npm run e2e                                     # schedule 5 real emails, assert delivery
npm run load-test -- --count 1200 --hourly-limit 200
curl -s localhost:4000/api/health | jq          # deps, queue depth, live config
open http://localhost:4000/admin/queues         # Bull Board (dev only)
```

---

## Ethereal setup

[Ethereal](https://ethereal.email) is a fake SMTP service: it accepts mail, never delivers it
to a real inbox, and gives you a web preview URL for every message. That makes "did this
actually send?" verifiable without spamming anyone.

**You do not need to create an account by hand.** Run:

```bash
npm run provision:ethereal -- --count 3
```

This calls Ethereal's account API, creates three throwaway SMTP accounts, and inserts them into
the `senders` table with host/port/user/pass. It prints the credentials and their inbox URLs.
Three senders exist so the **multiple-senders** requirement is real: each has its own hourly
quota, its own pooled Nodemailer transport, and appears in the Compose page's `From` dropdown.

- `-- --count N` — how many to create
- `-- --reset` — deactivate existing senders first

Because credentials live in the database rather than `.env`, adding a fourth sender is a script
run, not a redeploy. Every sent email stores its `previewUrl`; the dashboard's detail view links
straight to it, which is the fastest way to prove during a demo that a real message left the
building.

---

## Google OAuth setup

Real OAuth, not a mock. Two minutes:

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials** → **OAuth client
   ID** → application type **Web application**.
2. Under **Authorized JavaScript origins** add `http://localhost:3000`.
3. Copy the **Client ID** into `.env` — one variable, on the server only:

   ```dotenv
   GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   ```

4. Restart the API. The login card picks the Google button up automatically: it reads the client
   id from `GET /api/auth/config` at runtime, so there is no `NEXT_PUBLIC_*` twin to keep in sync,
   nothing is baked into the bundle at build time, and the button is never rendered when the
   server could not verify a token anyway.

This uses the Google Identity Services **ID-token** flow, so there is **no client secret** and no
redirect URI to configure. The browser receives a signed JWT from Google; the backend verifies it
with `google-auth-library`'s `verifyIdToken` against Google's public keys, then issues its own
httpOnly session cookie. A stolen client ID is worth nothing on its own.

The email/password form in the Figma is wired to a demo-only login path gated by
`ALLOW_PASSWORD_LOGIN`, which the API **refuses to enable when `NODE_ENV=production`**. It exists
so the dashboard is reviewable before anyone provisions credentials.

---

## Environment variables

All of it is validated by a zod schema at boot ([`apps/api/src/config/env.ts`](apps/api/src/config/env.ts)) —
a malformed value stops the process with a readable message instead of failing at 3am. Nothing
below is hardcoded anywhere in the source. `.env.example` is the annotated master copy.

### Scheduling, concurrency & pacing

| Variable | Default | What it does |
|---|---|---|
| `WORKER_CONCURRENCY` | `5` | Jobs a single worker process handles in parallel. |
| `MIN_DELAY_BETWEEN_SENDS_MS` | `2000` | **Minimum gap between two sends.** Enforced by BullMQ's Redis-backed limiter, so it holds across *all* worker processes. `0` disables. |
| `MAX_ATTEMPTS` | `3` | Delivery attempts before a job is failed. |
| `RETRY_BACKOFF_MS` | `5000` | Base for exponential retry backoff. |
| `RUN_WORKER_IN_API` | `true` | Run the worker inside the API process. Convenient locally; set `false` and scale `npm run start:worker` in production. |

### Rate limiting

| Variable | Default | What it does |
|---|---|---|
| `MAX_EMAILS_PER_HOUR` | `200` | Global ceiling across every sender. |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `100` | Default per-sender ceiling. A `Sender` row may override it; a campaign may request lower still. |
| `MAX_RESCHEDULES` | `48` | A job bumped into a later window this many times is failed rather than ping-ponging forever. |
| `RATE_LIMIT_REFUND_ON_FAILURE` | `false` | Refund reserved quota when a send fails. Off = never exceed a provider's real limit. |
| `SENDER_FAILOVER` | `false` | Re-route a job to another sender with spare quota instead of waiting for the next window. |

### Restart recovery

| Variable | Default | What it does |
|---|---|---|
| `STALE_LOCK_MS` | `300000` | A row stuck `PROCESSING` longer than this is treated as abandoned. |
| `RESEND_SUSPECT_JOBS` | `false` | Re-send a job whose outcome is unknowable (crashed after SMTP accepted, before the DB commit). Off = prefer a missed send over a duplicate. |
| `RECONCILE_INTERVAL_MS` | `300000` | Secondary self-healing sweep. **Not the scheduler.** `0` disables it and scheduling still works — there is a test for exactly that. |

### Infrastructure, auth, uploads

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` / `TEST_DATABASE_URL` | local | Postgres connection strings. The test DB is TRUNCATEd between tests. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection. |
| `QUEUE_PREFIX` | `reachinbox` | Namespaces every BullMQ key. Bump it for a clean queue without `FLUSHALL`. |
| `PORT` / `CORS_ORIGINS` | `4000` / `http://localhost:3000` | API port and credentialed origins. |
| `GOOGLE_CLIENT_ID` | — | Enables the Google button when set. |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | dev value / `7d` | Session cookie signing. Must be changed outside development. |
| `ALLOW_PASSWORD_LOGIN` / `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` | `true` / `demo@reachinbox.ai` / `demo1234` | Demo login. Refused in production. |
| `MAX_UPLOAD_BYTES` / `MAX_RECIPIENTS_PER_CAMPAIGN` / `UPLOAD_DIR` | `5 MiB` / `5000` / `./uploads` | Upload guards. |
| `API_ORIGIN` | `http://localhost:4000` | Where Next proxies `/api/*`. The only frontend variable — see [Google OAuth setup](#google-oauth-setup). |

---

## Architecture

```
  Next.js dashboard ──/api/* rewrite──► Express API ──┬──► PostgreSQL   (source of truth: what & when)
                                                      └──► Redis        (BullMQ: a rebuildable index)
                                                              │
                                                    BullMQ Worker(s) ──► Ethereal SMTP
                                                              │
                              Redis Lua hourly quota ◄────────┘  (atomic, global + per-sender)
```

The single most important design decision: **PostgreSQL is the source of truth for what must be
sent and when; Redis is a rebuildable index over it.** Every recovery property below falls out of
that. Full write-up in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Scheduling

`POST /api/campaigns` validates the payload with a zod schema shared verbatim with the frontend,
then in **one transaction** writes the `Campaign` row plus one `EmailJob` row per recipient with

```
scheduledAt = startAt + seq × delayBetweenMs
```

After the transaction commits, jobs are pushed with `queue.addBulk` in chunks of 500:

```ts
{
  name: 'send-email',
  opts: {
    jobId: emailJob.id,                                   // ← the idempotency key
    delay: Math.max(0, scheduledAt - Date.now()),         // ← BullMQ delayed job
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS },
    removeOnComplete: { age: 86400, count: 5000 },
    removeOnFail: false,
  },
}
```

Enqueue happens *after* commit, deliberately. A crash in the gap leaves rows in the database with
no queue job — which the reconciler fixes on the next boot. The reverse ordering would leave a
queue job with no row, which nothing can fix.

Baking the cadence into `scheduledAt` rather than only into the Redis delay is what lets a
restart reconstruct the exact schedule.

### Persistence & restart recovery

Two distinct failure modes, both handled by [`scheduler/reconciler.ts`](apps/api/src/scheduler/reconciler.ts),
which runs on every boot:

| Failure | What the reconciler sees | What it does |
|---|---|---|
| **Process restart** (crash, deploy, `kill -9`) | Redis kept the delayed jobs (AOF) | Finds them `intact` and leaves them alone. Nothing is re-queued, nothing is re-sent, nothing restarts from scratch. |
| **Redis loss** (flush, eviction, fresh container) | No jobs exist | Re-enqueues every outstanding row from its `scheduledAt` column. The schedule is reconstructed exactly. |
| **Time passed while down** | `scheduledAt` is in the past | Enqueues with `delay: 0` to catch up — still paced by the limiter and the hourly quota, so a long outage does not produce a burst. |
| **Abandoned in-flight work** | `PROCESSING` older than `STALE_LOCK_MS` | Applies the `RESEND_SUSPECT_JOBS` policy (default: mark indeterminate rather than risk a duplicate). |

It logs a one-line summary — `examined / requeued / caughtUp / intact / suspect / durationMs` —
which is what you watch during the restart demo.

Verified end to end, not just in tests: three emails scheduled 150 s out, all three API processes
`kill -9`'d mid-flight, rows confirmed still `SCHEDULED` with `attempts: 0` while the API was
unreachable, then restarted. The reconciler logged `examined: 3, requeued: 0, caughtUp: 0,
intact: 3, suspect: 0` — correctly recognising the jobs as healthy instead of blindly
re-enqueueing them, which is the behaviour that prevents duplicates. All three sent within ~3 s of
their original times with `attempts: 1`, `rescheduleCount: 0`, and the audit table showed exactly
one `PROCESSING` and one `SENT` row each.

### Idempotency: five independent layers

The requirement — *the same email must never be sent more than once* — is defended at five levels,
so no single bug or race can produce a duplicate.

1. **BullMQ job id.** `jobId = emailJob.id`. Re-adding an existing id is a silent no-op, so the
   reconciler can run as often as it likes and a double-submit cannot create a second job.
2. **Database uniqueness.** `@@unique([campaignId, toEmail])`. A lead list containing the same
   address five times produces one row.
3. **Atomic claim** — the one that matters under concurrency:

   ```sql
   UPDATE email_jobs SET status='PROCESSING', attempts=attempts+1, "lockedAt"=now(), "lockedBy"=$2
    WHERE id=$1 AND status IN ('SCHEDULED','QUEUED')
   ```

   Postgres evaluates the predicate as part of the write, so exactly one of *N* racing workers can
   make the transition. The losers get `count: 0` and stand down without touching SMTP. A
   read-then-write would leave a window in which two workers both believe they own the job.
4. **Terminal-state short-circuit.** A job that is already `SENT`/`CANCELLED`/`FAILED` returns
   immediately. This catches a BullMQ retry that fires after the send succeeded but before the
   completion was acknowledged.
5. **Completed-job retention.** `removeOnComplete: { age: 86400, count: 5000 }` keeps a window of
   finished ids in Redis so a replay is rejected before it reaches a worker at all.

On top of that, `email_events` is an append-only audit of every transition, which turns "it never
double-sends" from a claim into something you can check with one SQL query:

```sql
SELECT "emailJobId", count(*) FROM email_events WHERE status='SENT' GROUP BY 1 HAVING count(*) > 1;
```

### Rate limiting

Hourly quotas are enforced by a single **Redis Lua script**
([`hourly-quota.lua`](apps/api/src/ratelimit/hourly-quota.lua)) so the counters are correct across
any number of worker processes or instances — nothing is held in process memory.

- Keys are hour-windowed: `rl:global:{floor(now/3600000)}` and `rl:sender:{senderId}:{window}`.
- The script checks **both** ceilings before mutating **either**, then increments both, and sets a
  TTL only on the `0 → 1` transition so a busy window cannot slide forward forever.
- Returns `{1, globalRemaining, senderRemaining}` on allow, `{0, retryAfterMs, scope}` on refusal.

Lua rather than two round-trips because the check-and-reserve pair has to be indivisible.
Otherwise two workers both read "1 slot left" and both take it, or one increments the global
counter and *then* discovers the sender is full — leaking global quota to a send that never
happened.

**Both requirements are covered:** `MAX_EMAILS_PER_HOUR` is the global cap,
`MAX_EMAILS_PER_HOUR_PER_SENDER` the per-sender one, a `Sender` row can override its own, and a
campaign can request a lower limit than either. Multiple senders each carry an independent quota.

**When the cap is hit, nothing is dropped and nothing is failed.** The job is *moved*:

- the row goes back to `SCHEDULED` with a new `scheduledAt` at the start of the next window,
- the BullMQ job is re-delayed to the same instant via `moveToDelayed` + `DelayedError` — BullMQ's
  supported way to postpone from inside a processor without counting it as a failure,
- `rescheduleCount` is incremented, and the attempt counter is **rolled back**, because being
  throttled is not a delivery failure and must not burn a retry,
- an audit event records the scope and the new target time.

Order is preserved across the bump. The new time is `nextWindowStart + seq × MIN_DELAY_MS`,
derived purely from `(window, seq)` — never from elapsed time. An earlier version used
`max(now + retryAfterMs, …)`; because `retryAfterMs` is measured a few milliseconds before the
job is moved, each concurrently-deferred job picked up slightly different drift and the batch came
out of the next window scrambled. There is a test named *"preserves campaign order across the
deferral"* guarding that.

Only `rescheduleCount > MAX_RESCHEDULES` (default 48 — two days of windows) fails a job, so a
permanently-starved job cannot bounce forever.

Quota is reserved **before** the SMTP handoff and, by default, not refunded on failure
(`RATE_LIMIT_REFUND_ON_FAILURE=false`). A crash can therefore only *under*-use the allowance,
never exceed the provider's real limit. Flip the flag if you would rather maximise throughput.

### Concurrency & minimum delay between sends

- `WORKER_CONCURRENCY` (default `5`) sets how many jobs one worker process runs in parallel. All
  the shared state a parallel job touches — the claim, the quota — is atomic, so raising it is
  safe. `npm run start:worker` can be scaled to as many processes as you like.
- `MIN_DELAY_BETWEEN_SENDS_MS` (default **2000 ms**, i.e. *minimum 2 seconds between sends*) is
  implemented with BullMQ's worker limiter, `{ max: 1, duration: MIN_DELAY_BETWEEN_SENDS_MS }`.
  The limiter is **Redis-backed**, so it paces the whole fleet rather than each process
  independently — an in-process `setTimeout` would silently multiply throughput by the number of
  workers.
- The two interact the way you would want: the limiter is the ceiling, so concurrency buys
  parallelism for slow SMTP round-trips without ever exceeding the pacing budget.
- Per-campaign spacing (`delayBetweenSeconds` from the Compose form) is *additionally* baked into
  each row's `scheduledAt`, so a campaign's own cadence survives a restart independently of the
  global limiter.
- `lockDuration: 60s` with `stalledInterval: 30s` lets BullMQ recover a job from a dead worker;
  the database claim is what makes that recovery safe.

### Behaviour under load (1000+ emails)

Design points that matter at 1000+:

- recipient rows are inserted with a single `createMany` inside one transaction, not 1000
  round-trips holding the transaction open,
- jobs are enqueued with `addBulk` in chunks of 500 (one round-trip per chunk, not per email),
- the burst is spread by per-campaign spacing, then by the global limiter, then by the hourly cap,
- overflow rolls into subsequent windows **in order** rather than failing.

The arithmetic the API returns to the UI before you submit (`projectedCompletionAt`,
`windowsRequired`, `throttledByHourlyLimit`) comes from `projectCampaign()` in the shared package —
the same function the dashboard runs client-side, so the warning you see in Compose is the
server's own projection. 1000 emails at `MAX_EMAILS_PER_HOUR=200` drains over 5 hourly windows;
the first 200 go immediately.

```bash
npm run load-test -- --count 1200 --hourly-limit 200
```

schedules 1200 emails for the same instant and prints the projected drain per window. A test
covers the 1000-row insert path directly (*"handles a 1000-recipient batch in one transaction"*,
479 ms).

---

## No cron, anywhere

The assignment forbids cron. To be precise about what is and is not in here:

- **No** `node-cron`, **no** `agenda`, **no** `node-schedule`, **no** OS crontab, **no** systemd
  timers. Nothing parses a cron expression.
- Scheduling is **BullMQ delayed jobs**: each email is a job with `delay = scheduledAt - now`,
  and Redis's own delayed-set machinery promotes it when it comes due.
- There *is* one `setInterval` — the reconciler's drift-repair sweep (`RECONCILE_INTERVAL_MS`,
  default 5 minutes). It is a **self-healing repair loop, not the scheduling mechanism**. Set
  `RECONCILE_INTERVAL_MS=0` and emails still send at the right time; the test
  *"is disabled by `RECONCILE_INTERVAL_MS=0` and scheduling still works"* proves it.
- **Lockfile footnote:** `npm ls cron-parser` shows a match. It is a transitive dependency of
  `bullmq`, which needs it for the *repeatable jobs* feature. This project never calls
  `queue.add` with a `repeat` option and registers no job scheduler, so that code path is never
  reached. Flagging it so a grep for "cron" during review has an answer already written down.

---

## Feature list

**Scheduling & delivery**
- Per-recipient job scheduling with configurable start time and inter-email delay
- BullMQ delayed jobs, no cron
- Survives process restart *and* Redis loss with the schedule intact
- Five-layer idempotency + append-only audit trail
- Configurable worker concurrency, safe in parallel
- Redis-backed minimum delay between sends, shared across all workers
- Global and per-sender hourly rate limits, Lua-atomic, multi-instance safe
- Over-cap jobs deferred into the next window in order, never dropped or failed
- Exponential-backoff retries; SMTP-rejected recipients failed terminally rather than retried
- Multiple Ethereal senders, each with its own quota and pooled transport; optional failover
- Cancel a scheduled email before it sends
- Graceful SIGTERM/SIGINT shutdown: stop accepting HTTP → let in-flight sends finish →
  close queue, transports, Prisma, Redis, with a 20 s force-exit backstop

**API**
- Real Google OAuth (ID-token verification) + httpOnly JWT session; demo login for review
- Campaign creation with CSV/TXT lead upload and attachments (multipart)
- Lead parsing that reports duplicates removed and invalid rows instead of silently dropping them
- Paginated, searchable email listing; detail; star; cancel; sidebar stats
- Health endpoint reporting DB, Redis, queue depth and the live tuning config
- Bull Board queue inspector in development
- helmet, CORS with credentials, pino request logging with request ids, zod validation on every
  input, central error handler, express-rate-limit on the API surface, HTML sanitisation of email
  bodies

**Dashboard**
- Google sign-in, plus a demo path so it is reviewable without credentials
- Sidebar with user name/email/avatar, logout, and live Scheduled/Sent counts
- Scheduled and Sent tabs (one component, one `mailbox` prop) with debounced search, refresh,
  pagination, skeleton loading, three distinct empty states, and polling so rows move
  Scheduled → Sent live
- Compose: sender picker, recipient chips with `+N` overflow, lead-list upload showing the
  **count of detected addresses**, subject, rich-text body (Tiptap), delay + hourly limit,
  attachments, and a Send Later popover with quick picks
- Pre-submit projection warning when a batch will span multiple hour windows
- Email detail with the audit fields (attempts, reschedule count, last error) and the Ethereal
  preview link
- Reusable UI library (Button, Input, Select, Chip, Avatar, Popover, Toast, Skeleton,
  EmptyState, FileDropzone, SearchBar…), design tokens in one Tailwind theme rather than one-off
  hex values in components (the Google G logo's fixed brand colours being the one exception),
  typed end to end against schemas shared with the backend

---

## Testing & verification

```bash
npm test
```

**107 tests across 7 files**, run against a real Redis and a real PostgreSQL — not mocks, because
the properties being tested (Lua atomicity, `UPDATE … WHERE` claim semantics, BullMQ delayed-set
behaviour) are properties of those systems and a mock would only test the mock.

| Suite | What it proves |
|---|---|
| `idempotency.test.ts` | Each of the five layers independently; N parallel workers on one job produce exactly one send |
| `rate-limiter.test.ts` | Concurrent reservations never exceed the cap; refusal leaves no trace; window rollover; TTL set once |
| `throttling.test.ts` | Over-cap jobs are deferred, **not** failed; campaign order survives the deferral; 1000-recipient batch |
| `reconciler.test.ts` | Restart with Redis intact touches nothing; Redis loss rebuilds the full schedule; past-due catch-up; stale-claim policy; scheduling works with the sweep disabled |
| `api.test.ts` | Auth, validation, pagination, ownership isolation, health |
| `scheduling.test.ts` | Window maths, per-seq spacing, campaign projection, reschedule targets |
| `parse-recipients.test.ts` | CSV/TXT parsing, BOM + CRLF, `Name <addr>` forms, dedupe, invalid-line reporting |

Beyond the suite:

```bash
npm run e2e -- --count 5     # schedules real emails, waits, asserts SENT + preview URLs
```

The restart scenario was also exercised by hand against a live stack; the result is written up in
[Persistence & restart recovery](#persistence--restart-recovery) and the shot list is in
[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

---

## Project layout

```
├── docker-compose.yml            postgres + redis (AOF, noeviction)
├── scripts/
│   ├── dev-services.sh           no-Docker fallback: local postgres + redis
│   ├── provision-ethereal.ts     mint N Ethereal accounts → seed `senders`
│   ├── load-test.ts              schedule 1200+ emails, print the drain projection
│   └── e2e-verify.ts             schedule → wait → assert delivered
├── packages/shared/              zod schemas, constants, scheduling maths, lead parsing
│                                 — one contract, imported by both apps
└── apps/
    ├── api/
    │   ├── prisma/               schema, migrations, seed
    │   └── src/
    │       ├── index.ts server.ts worker.ts    API / combined / worker-only entrypoints
    │       ├── config/env.ts                   zod-validated env, fails fast
    │       ├── queue/                          connection, queue, worker, events
    │       ├── ratelimit/                      Lua script + wrapper
    │       ├── scheduler/                      scheduleCampaign, reconciler
    │       ├── mail/                           transports, sendEmail, Ethereal
    │       ├── modules/                        auth, campaigns, emails, senders, health
    │       └── middleware/                     auth, upload, errors, rate limit, request ctx
    └── web/src/
        ├── app/                  login, (dashboard)/{scheduled,sent,compose,email/[id]}
        ├── components/ui/        the reusable primitives
        ├── features/             auth, emails, compose
        ├── hooks/                useAuth, useEmails, useStats, useSenders
        └── lib/                  api client, query client, formatting
```

The shared package is the reason the frontend and backend cannot drift: the same zod schema
validates the Compose form and the `POST /api/campaigns` body, and the same `projectCampaign()`
computes the warning in the UI and the projection in the response.

---

## Pushing to GitHub

The repository must be **private** and shared with `Mitrajit` and `Yadav036`. Neither the `gh`
CLI nor GitHub credentials were available in the build environment, so this is the one step left
to run by hand:

```bash
# 1. Create an empty PRIVATE repo at https://github.com/new  (no README, no .gitignore)

# 2. Push
git remote add origin git@github.com:<your-username>/reachinbox-scheduler.git
git branch -M main
git push -u origin main

# 3. Grant access:
#    Settings → Collaborators → Add people → `Mitrajit`, then `Yadav036`
```

With the `gh` CLI the whole thing is:

```bash
gh repo create reachinbox-scheduler --private --source=. --remote=origin --push
gh api -X PUT repos/:owner/reachinbox-scheduler/collaborators/Mitrajit
gh api -X PUT repos/:owner/reachinbox-scheduler/collaborators/Yadav036
```

Double-check `.env` is not committed — it is in `.gitignore`, and `git status --ignored` will
confirm.

---

## Assumptions & trade-offs

The short version; the reasoning is in [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md).

- **A crash between SMTP acceptance and the database commit is unknowable.** Default policy is to
  mark such a row indeterminate rather than re-send it: a missed email is recoverable by a human,
  a duplicate is not. `RESEND_SUSPECT_JOBS=true` flips it.
- **Quota is reserved before the send and not refunded on failure.** Guarantees a provider's real
  limit is never exceeded, at the cost of occasionally under-using it.
- **Hour windows are fixed wall-clock hours**, not a sliding window. It matches how providers
  actually publish limits and makes "the next available hour" unambiguous to a user.
- **Ethereal SMTP passwords are stored in plain columns.** These are disposable test inboxes; a
  real deployment would hold a KMS reference. Called out rather than hidden.
- **Attachments are stored on the local filesystem** under `UPLOAD_DIR`. S3 is the obvious
  swap; the storage path is already a single field on the row.
- **Uploaded lead lists are parsed and deleted immediately** — the address list itself is never
  retained on disk.
- **The demo password login exists** so the dashboard can be reviewed without Google credentials.
  It is refused when `NODE_ENV=production`.
- **The worker runs in the API process by default** (`RUN_WORKER_IN_API=true`) so one command boots
  everything for review. Production would run them separately and scale the worker.
- **Docker Compose ships the datastores only.** Docker was unavailable in the build environment,
  so app images would have been untested code presented as working; the npm path is the verified
  one. See the comment at the top of `docker-compose.yml`.
- **Not built:** unsubscribe handling, bounce/webhook processing, open/click tracking, template
  variables, timezone-aware "send at 9am local", multi-tenant org accounts. All out of scope for
  the brief, all listed here rather than left for you to notice.
