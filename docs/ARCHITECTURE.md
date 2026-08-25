# Architecture

This document explains *why* the system is shaped the way it is. The README covers how to run
it; [API.md](API.md) covers the surface. Here the concern is the four hard properties the brief
asks for — **schedule without cron**, **survive a restart**, **never send twice**, **never exceed
a rate limit** — and the design decisions each one forced.

---

## 1. The one decision everything else follows from

> **PostgreSQL is the source of truth for what must be sent and when. Redis is a rebuildable
> index over it.**

Every recovery property in this document is a consequence of that sentence.

The tempting alternative is to treat the queue as the system of record: push a delayed job, let
Redis own the schedule, keep the database as a reporting mirror. It is less code and it works
until Redis restarts without AOF, gets flushed, evicts under memory pressure, or is replaced by a
fresh container — at which point the schedule is simply gone, with no way to tell what was lost.

So the write path is ordered deliberately:

```
1. BEGIN
2.   INSERT campaign
3.   INSERT email_jobs   (one row per recipient, each with its own scheduledAt)
4. COMMIT
5. queue.addBulk(...)    ← after the commit, never inside it
```

A crash between 4 and 5 leaves rows in the database with no queue job. That is *recoverable* —
the reconciler notices on the next boot and enqueues them. The reverse ordering would leave a
queue job pointing at a row that was never committed, which nothing can repair. Enqueueing inside
the transaction is worse still: Redis has no idea what a Postgres rollback is, so an aborted
transaction would leave live jobs for emails that do not exist.

The corollary is that the cadence must be **materialised per row**, not held in a worker's
memory:

```ts
scheduledAt = startAt + seq × delayBetweenMs
```

`seq` and `scheduledAt` are columns. That is what lets a cold start reconstruct the exact same
schedule, and what lets a throttled batch be re-timed later without losing its ordering.

---

## 2. Scheduling without cron

Each email is one BullMQ job with a delay:

```ts
await emailQueue.addBulk(chunk.map((job) => ({
  name: EMAIL_JOB_NAME,
  data: { emailJobId, campaignId, seq },
  opts: {
    jobId: emailJobId,                              // idempotency key
    delay: Math.max(0, +scheduledAt - Date.now()),  // the actual scheduling primitive
    attempts: env.MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.RETRY_BACKOFF_MS },
    removeOnComplete: { age: 86_400, count: 5_000 },
    removeOnFail: false,
  },
})));
```

Redis holds these in a sorted set keyed by due-time and promotes them to the wait list when they
come due. No polling loop, no cron expression, no timer wheel in Node — and because the delay
lives in Redis rather than in a `setTimeout`, a process restart does not lose it.

`addBulk` is chunked at 500. `addBulk` builds a single Redis pipeline, so 5000 jobs in one call
is one enormous round-trip that blocks Redis for everyone else; 500 is large enough that the
per-round-trip overhead disappears and small enough that no single pipeline monopolises the
server.

### The one `setInterval`, and why it is not a cron

There is a `setInterval` in `scheduler/reconciler.ts` that re-runs the reconciler every
`RECONCILE_INTERVAL_MS` (default 5 minutes). It is worth being precise about what it is:

- It is a **self-healing repair sweep**, not the scheduling mechanism. It looks for rows that
  *should* have a queue job and do not.
- Under normal operation it finds nothing and does nothing.
- Setting `RECONCILE_INTERVAL_MS=0` disables it entirely and emails still send at the correct
  time. The test *"is disabled by `RECONCILE_INTERVAL_MS=0` and scheduling still works"* asserts
  exactly that, so the claim is falsifiable rather than rhetorical.

No cron library is installed. `cron-parser` appears in the lockfile as a transitive dependency of
`bullmq` (it backs BullMQ's repeatable-jobs feature); this project never passes a `repeat` option
and registers no job scheduler, so that code path is never reached.

---

## 3. Surviving a restart

`reconcile()` runs on every boot, before the worker starts accepting jobs. It loads every
`EmailJob` still in `SCHEDULED`, `QUEUED` or `PROCESSING` and asks one question per row: *does a
healthy queue job exist for this?*

| Situation | Detection | Action |
|---|---|---|
| Process restarted, Redis intact | `queue.getJob(id)` returns a job | `intact++`. **Do nothing.** |
| Redis lost / flushed / fresh container | `getJob(id)` returns nothing, `scheduledAt` in the future | Re-enqueue with `delay = scheduledAt − now` → `requeued++` |
| Time passed while the service was down | no job, `scheduledAt` in the past | Enqueue with `delay: 0` → `caughtUp++` |
| Worker died mid-send | `PROCESSING` and `lockedAt` older than `STALE_LOCK_MS` | Apply the `RESEND_SUSPECT_JOBS` policy → `suspect++` |

Two details do the real work.

**Doing nothing is a feature.** The obvious implementation of "recover on boot" is to re-enqueue
everything outstanding. That is precisely how you get duplicate sends after a routine deploy. The
reconciler checks first and leaves healthy jobs alone; `intact` being the large number in the log
line is the system working correctly.

**`jobId` is the row id.** Even if the check were wrong, re-adding an existing `jobId` is a no-op
in BullMQ. The safety property does not depend on the check being right — there is a test named
*"keeps the job id equal to the row id, so a rebuild cannot duplicate"* pinning that invariant,
because it would be easy for a future refactor to introduce a `${id}-retry` suffix and silently
delete the guarantee.

Catch-up sends are not a thundering herd: they go through the same Redis limiter and the same
hourly quota as everything else, so a two-hour outage drains at the configured pace rather than
firing 400 emails in one second.

**Verified against a live stack, not only in tests.** Three emails scheduled 150 s out; all API
processes `kill -9`'d; rows confirmed still `SCHEDULED` with `attempts: 0` while the API was
unreachable; restart. The reconciler logged:

```
reconcile complete  examined: 3, requeued: 0, caughtUp: 0, intact: 3, suspect: 0, durationMs: 17
```

All three then sent within ~3 s of their original times with `attempts: 1` and
`rescheduleCount: 0`, and `email_events` showed exactly one `PROCESSING` and one `SENT` row per
email — no double-claim across the crash.

### The unknowable case

A process can die *after* SMTP accepted the message but *before* the `SENT` row commits. The row
is left `PROCESSING` and there is no way to determine from inside the system which side of the
handoff it died on. Any design must choose:

- `RESEND_SUSPECT_JOBS=false` **(default)** — mark it indeterminate. Risks a missed email.
- `RESEND_SUSPECT_JOBS=true` — send again. Risks a duplicate.

The default is the conservative one because the brief's explicit requirement is *never send
twice*, and because the two failure modes are not symmetric: a missed email is visible in the
dashboard with its error text and a human can resend it; a duplicate has already landed in a
prospect's inbox and cannot be recalled. The flag exists because that trade-off is a policy
decision, not a technical one, and a different deployment may weigh it differently.

---

## 4. Idempotency

Five independent layers. The point of the redundancy is that no single bug can produce a
duplicate — each layer would have to fail simultaneously.

### Layer 1 — BullMQ job id

`jobId = emailJob.id`. Adding an existing id is a silent no-op. This makes the *producer* side
idempotent: reconciler re-runs, retries of the enqueue step, and a double-submitted form cannot
create a second job.

### Layer 2 — database uniqueness

```prisma
@@unique([campaignId, toEmail])
```

A lead list containing the same address five times produces one row. `createMany` runs with
`skipDuplicates: true`, so the upload succeeds with a smaller count rather than failing — and the
API reports `duplicatesRemoved` so the user knows.

### Layer 3 — the atomic claim

This is the one that matters under concurrency:

```sql
UPDATE email_jobs
   SET status = 'PROCESSING', attempts = attempts + 1,
       "lockedAt" = now(), "lockedBy" = $2
 WHERE id = $1 AND status IN ('SCHEDULED','QUEUED')
```

Postgres evaluates the `WHERE` as part of the write under row-level locking, so of *N* workers
racing for the same job, exactly one sees `count: 1`. The losers see `count: 0` and return
without touching SMTP.

The naive version —

```ts
const row = await prisma.emailJob.findUnique(...);       // both read SCHEDULED
if (row.status !== 'SCHEDULED') return;                  // both pass
await prisma.emailJob.update({ status: 'PROCESSING' });  // both send
```

— has a window between the read and the write in which both workers believe they own the job. It
looks correct, passes a single-worker test, and duplicates under load. The integration suite
launches parallel workers against one job and asserts exactly one send, so the difference is
covered by a test rather than by a comment.

### Layer 4 — terminal-state short-circuit

Before claiming, the worker checks the current status. Already `SENT` → return `already-sent`
without sending. Already `CANCELLED` or exhausted-`FAILED` → return. This catches a BullMQ retry
that fires *after* the send succeeded but before completion was acknowledged, which is exactly
what happens when a worker is killed in the microseconds between the two.

### Layer 5 — completed-job retention

`removeOnComplete: { age: 86400, count: 5000 }` keeps finished job ids in Redis for a day, so a
replayed id is rejected before a worker is ever handed the job.

### The audit trail

`email_events` is append-only: every transition writes a row with the worker id that caused it.
It turns "we never double-send" from an assertion into a one-line check:

```sql
SELECT "emailJobId", count(*)
  FROM email_events WHERE status = 'SENT'
 GROUP BY 1 HAVING count(*) > 1;
```

Writing an audit event is wrapped in try/catch — a failure to log must never break a send, but it
should be visible in the logs.

---

## 5. Rate limiting

Two ceilings apply simultaneously: a global one (`MAX_EMAILS_PER_HOUR`) and a per-sender one
(`MAX_EMAILS_PER_HOUR_PER_SENDER`, overridable per `Sender` row, and lowerable per campaign).

### Why Lua

The operation is *check two counters, and increment both only if both have room*. As two
round-trips it races in two distinct ways:

1. Two workers both read "1 slot left" and both take it → the cap is exceeded.
2. One worker increments the global counter, then discovers the sender is full → global quota is
   leaked to a send that never happened, and legitimate emails are pushed into the next hour for
   no reason.

`EVAL` runs the whole check-and-reserve atomically inside Redis, which eliminates both. Redis —
not process memory — holding the counters is also what makes the limit correct across multiple
worker processes and multiple machines; an in-memory counter would multiply the effective limit
by the number of instances.

```lua
-- Check BOTH ceilings before mutating EITHER, so a refusal leaves no trace.
if global_used >= global_limit then return { 0, retry_after, 'global' } end
if sender_used >= sender_limit then return { 0, retry_after, 'sender' } end
local global_now = redis.call('INCR', global_key)
local sender_now = redis.call('INCR', sender_key)
if global_now == 1 then redis.call('EXPIRE', global_key, ttl_seconds) end
if sender_now == 1 then redis.call('EXPIRE', sender_key, ttl_seconds) end
```

The TTL is set only on the `0 → 1` transition. Refreshing it on every increment would let a busy
window slide forward indefinitely and never reset — a classic and quiet bug.

Keys are hour-windowed (`rl:global:{floor(now/3600000)}`, `rl:sender:{id}:{window}`), so windows
expire themselves and there is no cleanup job.

### What happens at the cap

The requirement is explicit: do not drop, do not fail — **delay into the next available window,
preserving order**. So the job is *moved*:

1. `rescheduleTarget({ now, seq, minDelayMs })` computes
   `nextWindowStart + seq × MIN_DELAY_BETWEEN_SENDS_MS`.
2. The row returns to `SCHEDULED` with that new `scheduledAt`, and **the attempt counter is
   decremented** — being throttled is not a delivery failure and must not consume a retry.
3. `rescheduleCount` is incremented, and an audit event records the scope and the target.
4. `job.moveToDelayed(target, token)` followed by `throw new DelayedError()` — BullMQ's supported
   way to postpone from inside a processor without it counting as a failure.

Only `rescheduleCount > MAX_RESCHEDULES` (default 48, i.e. two days of windows) marks a job
`FAILED`, so a permanently-starved job cannot bounce forever.

**Ordering was a real bug, fixed.** The first version computed the target as
`max(now + retryAfterMs, nextWindow) + seq × delay`. Because `retryAfterMs` is measured inside
`reserve()` a few milliseconds before the move, each concurrently-deferred job picked up slightly
different drift, and a batch bumped into the next window came out scrambled. Deriving the target
purely from `(window, seq)` makes it deterministic: two jobs deferred 30 ms apart land in the same
relative order they started in. The test *"preserves campaign order across the deferral"* guards
it.

### Reserve-before-send

Quota is consumed *before* the SMTP handoff, and by default not refunded when the send fails
(`RATE_LIMIT_REFUND_ON_FAILURE=false`). A crash can therefore only ever *under*-use the
allowance. The alternative — reserve after a successful send — means a crash mid-send leaves the
counter un-incremented and a retry can push the real send count above a provider's limit, which
is the failure mode that gets a domain blocked.

---

## 6. Concurrency and pacing

Three independent controls, deliberately not collapsed into one:

| Control | Scope | Mechanism |
|---|---|---|
| `WORKER_CONCURRENCY` | per worker process | BullMQ `concurrency` |
| `MIN_DELAY_BETWEEN_SENDS_MS` | **the whole fleet** | BullMQ `limiter: { max: 1, duration }` — Redis-backed |
| `delayBetweenSeconds` (Compose) | one campaign | baked into each row's `scheduledAt` |

The limiter being Redis-backed is the load-bearing part. An in-process `setTimeout` between sends
looks equivalent on one machine and silently multiplies throughput by the number of worker
processes the moment you scale out — the exact bug the brief's "safe across multiple workers"
requirement is asking about.

They compose the way you would want: the limiter is a ceiling, so raising concurrency buys
parallelism for slow SMTP round-trips (connecting, TLS, waiting on the server) without ever
exceeding the pacing budget. Per-campaign spacing is separate again, so one campaign's "one email
every 30 seconds" is preserved through a restart even though the global limiter knows nothing
about campaigns.

`lockDuration: 60_000` with `stalledInterval: 30_000` and `maxStalledCount: 2` lets BullMQ
reclaim a job from a dead worker. That recovery is only safe *because* of the database claim —
BullMQ handing the same job to a second worker is exactly the scenario layer 3 exists for.

---

## 7. Behaviour at 1000+ emails

What changes at scale, and what was done about each:

| Cost at 1000+ | Mitigation |
|---|---|
| 1000 individual `INSERT`s hold a transaction open for seconds | one `createMany` |
| 1000 `queue.add` calls = 1000 round-trips | `addBulk`, chunked at 500 |
| One pipeline of 5000 jobs blocks Redis | the same 500 chunk, from the other direction |
| 1000 emails arriving in one second | per-campaign spacing → global limiter → hourly quota, in that order |
| The user has no idea a batch will take 5 hours | `projectCampaign()` returns `projectedCompletionAt`, `windowsRequired`, `throttledByHourlyLimit` |

`projectCampaign()` lives in `packages/shared` and is called from **both** sides: the Compose form
runs it as you type to warn that a batch will span multiple windows, and the API runs it to build
the response. One implementation, so the warning cannot disagree with reality.

1000 emails at `MAX_EMAILS_PER_HOUR=200` drains across 5 hour windows, first 200 immediately, the
rest deferred in order. `npm run load-test -- --count 1200 --hourly-limit 200` schedules the batch
and prints the projected drain; the integration suite covers the 1000-row insert path directly.

---

## 8. Multiple senders

`Sender` rows carry their own SMTP credentials and their own optional `maxEmailsPerHour`.
`scripts/provision-ethereal.ts` mints real Ethereal accounts through their API and seeds the
table, so "support multiple senders" is exercised rather than merely modelled.

- Nodemailer transports are **pooled and cached by sender id**, so a campaign does not open a new
  TCP+TLS connection per email.
- Each sender has an independent quota key, so one saturated mailbox does not stall the others.
- `GET /api/senders` reports live usage against the current window, which is what lets the Compose
  dropdown show a nearly-capped sender before you schedule into it.
- `SENDER_FAILOVER=true` (off by default) re-routes a job to another sender with spare quota
  instead of waiting for the next window. It is off by default because for cold outreach the From
  address is part of the campaign's identity, and silently sending from a different mailbox is
  usually wrong — but for transactional mail it is obviously right, so it is a flag.

---

## 9. Process topology

Three entrypoints over one codebase:

| Entrypoint | Command | What it runs |
|---|---|---|
| `src/index.ts` | `npm run dev:api` | HTTP API, plus the worker when `RUN_WORKER_IN_API=true` |
| `src/server.ts` | — | the Express app factory, imported by the API and by the tests |
| `src/worker.ts` | `npm run dev:worker` | worker only, no HTTP |

Default is worker-in-API so one command boots everything for review. Production sets
`RUN_WORKER_IN_API=false` and scales `start:worker` independently — which is safe precisely
because the claim and the quota are atomic and shared.

Shutdown order is part of the correctness story, not housekeeping:

```
stop the reconcile sweep
  → stop accepting HTTP        (nothing new gets scheduled mid-teardown)
    → worker.close(false)      (let in-flight sends finish and commit)
      → queue events → queue → SMTP transports → Prisma → Redis
```

with a 20-second force-exit backstop so a hung SMTP socket cannot block the exit forever. Closing
the worker *before* its dependencies is what keeps a SIGTERM from leaving rows stranded in
`PROCESSING` — the ambiguous state §3 has to guess about.

---

## 10. The shared package

`packages/shared` holds the zod schemas, the status constants, the scheduling maths and the lead
parser. Both apps import it directly from source.

This is not just tidiness. It means:

- the schema validating the Compose form **is** the schema validating `POST /api/campaigns`,
- the "N email addresses detected" count in the upload widget is produced by the same
  `parseRecipients()` the server runs on submit, so the number cannot lie,
- `EMAIL_STATUS` and `MAILBOX_FILTERS` cannot drift between the tab definitions and the query,
- `projectCampaign()` gives identical answers on both sides.

The cost is one webpack setting: the package is authored for Node's ESM resolver with explicit
`.js` extensions, which TypeScript maps back to `.ts` but webpack does not. `next.config.mjs`
adds `resolve.extensionAlias` to teach it the same mapping. Worth it to delete an entire class of
frontend/backend drift bug.

---

## 11. Frontend notes

Only the parts where the reasoning is not obvious from the code.

**One list component, two tabs.** Scheduled and Sent are the same `EmailList` with a `mailbox`
prop. The only genuine visual difference is the status chip — amber `🕐 Tue 9:15:12 AM` when
pending, grey `Sent` when delivered — so that is the only thing branching. Search, pagination,
skeletons, empty states and error handling exist once.

**Polling, not websockets.** TanStack Query refetches every 5 s on Scheduled and 15 s on Sent,
with `placeholderData: (prev) => prev` so a refetch never blanks the table. Rows visibly move
Scheduled → Sent during a demo. Websockets would be the right call at production scale and
significant extra surface for a dashboard one person watches.

**The Google button is an overlay, and it has to be.** The backend verifies an *ID token*, which
only Google Identity Services' own button or One Tap can mint (`useGoogleLogin`'s OAuth2 flow
yields an access token instead). That button renders inside a Google-owned iframe that cannot be
restyled, and a synthetic `.click()` on it is ignored by design. So the real GIS button is
rendered transparently *on top of* the Figma-styled one: the visible button is `aria-hidden` with
`tabIndex={-1}`, and the invisible real control receives the genuine user gesture and keyboard
focus.

**Auth guard distinguishes two failures.** Signed-out redirects to `/login`; API-unreachable
renders an error card. Conflating them produces a redirect loop against a down server, which
looks like a frontend bug and is not.

**Tailwind config paths are absolute.** `content` globs and the config path itself resolve
against the *process* cwd, so a build launched from the monorepo root found no config and emitted
a stylesheet containing only preflight — surfacing as "the `text-ink` class does not exist"
rather than anything mentioning configuration. `postcss.config.mjs` anchors the config path to
itself and `tailwind.config.ts` anchors `content` with `join(__dirname, …)`, so the build behaves
identically from any directory — including whatever cwd CI happens to pick.
