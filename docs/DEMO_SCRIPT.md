# Demo script — 5 minutes

A shot-by-shot script for the submission video. It covers the four things the brief asks to see:
**scheduling**, **the dashboard**, **the restart scenario**, and the bonus **rate-limit
behaviour** — in that order, with the timings that fit inside five minutes.

Written to be followed literally: every command is copy-pasteable and every number below is one
that was actually observed on a live run.

---

## Before you hit record

**1. Configure for a demo, not for production.** The defaults are tuned for realism, which is too
slow to film. In `.env`:

```dotenv
MIN_DELAY_BETWEEN_SENDS_MS=2000
MAX_EMAILS_PER_HOUR=200
MAX_EMAILS_PER_HOUR_PER_SENDER=5     # ← small, so the rate-limit demo happens on camera
WORKER_CONCURRENCY=5
RECONCILE_INTERVAL_MS=300000
```

`MAX_EMAILS_PER_HOUR_PER_SENDER=5` is the trick that makes segment 4 possible: an 8-recipient
campaign then hits the cap on camera instead of an hour from now. Say out loud that it is
configured low for the demo — a reviewer should never suspect a number was staged silently.

**2. Bring the stack up and confirm it is healthy.**

```bash
docker compose up -d          # or: bash scripts/dev-services.sh up
npm run db:migrate
npm run provision:ethereal -- --count 3
npm run dev
curl -s localhost:4000/api/health | jq .data
```

**3. Window layout.** Browser at `http://localhost:3000` on the left; a terminal tailing API logs
on the right. Both visible at once — the log line is the evidence for what the UI is showing.

**4. Have these ready in tabs or scrollback**, so nothing is typed from memory on camera:

```bash
# audit trail: proves no double-send
psql "$DATABASE_URL" -c "SELECT \"emailJobId\", status, \"createdAt\" FROM email_events ORDER BY \"createdAt\" DESC LIMIT 20;"

# what Redis is actually holding
redis-cli ZCARD reachinbox:email-send:delayed

# row state
psql "$DATABASE_URL" -c "SELECT \"toEmail\", status, \"scheduledAt\", attempts, \"rescheduleCount\", \"sentAt\" FROM email_jobs ORDER BY seq;"
```

Note the Redis key prefix is `reachinbox:`, from `QUEUE_PREFIX` — not the default `bull:`.

---

## 0:00 – 0:25 · Login

- Land on `/login`. Show the card: **Login with Google** and the demo email/password form.
- Sign in with Google if credentials are configured; otherwise use `demo@reachinbox.ai` /
  `demo1234` and say why: *"the login card renders from `GET /api/auth/config`, so it only offers
  Google when the server can actually verify a Google ID token. Both paths are real; the demo one
  is refused in production."*
- Land on the dashboard. Point at the sidebar: avatar, name, email, logout, and the live
  Scheduled / Sent counts.

## 0:25 – 1:20 · Compose and schedule

- Click **Compose**.
- **From** — open the dropdown, show three Ethereal senders. *"Provisioned by a script against
  Ethereal's API; each has its own hourly quota."*
- **Upload List** — drop a CSV of 8 leads. Point at **"8 email addresses detected"**, and at the
  duplicate/invalid counts if your file has any. *"Parsed in the browser by the same function the
  server runs on submit, so the count can't disagree with what gets scheduled."*
- **Subject** and a short body; use the toolbar once so the rich-text editor is visibly real.
- **Delay between 2 emails: 5** · **Hourly Limit: 5**.
- Click the clock → **Send Later** → pick a time ~90 seconds out → **Done**. The button becomes
  **Send Later**.
- Before submitting, point at the projection warning if it appears (*"this batch will span N hour
  windows"*) — *"that's the server's own arithmetic, running client-side from the shared package."*
- Submit. Toast confirms; you land on **Scheduled**.

## 1:20 – 2:10 · The dashboard doing its job

- Show the Scheduled tab: 8 rows, each with an amber `🕐 Tue 9:15:12 AM` chip, spaced 5 seconds
  apart.
- In the terminal:

  ```bash
  redis-cli ZCARD reachinbox:email-send:delayed     # → 8
  ```

  *"Eight delayed jobs in Redis, one per recipient. No cron, no polling loop — BullMQ delayed
  jobs."*
- Wait for the start time. Rows move **Scheduled → Sent** live (the list polls every 5 s). Watch
  the sidebar counts change.
- Switch to **Sent**, open one email. Show the detail view: sender block, body, and the **Ethereal
  preview link**. Click it — the real delivered message opens. *"Not a mock: that's the message as
  the SMTP server received it."*
- Point at the audit block: `attempts: 1`, `rescheduleCount`, no error.

## 2:10 – 3:30 · Restart scenario ⚠ the important one

This is the segment reviewers care most about. Don't rush it.

- Schedule a fresh campaign, 3 recipients, start time **~2.5 minutes out**. Confirm on Scheduled.
- Show the pre-kill state:

  ```bash
  redis-cli ZCARD reachinbox:email-send:delayed
  psql "$DATABASE_URL" -c "SELECT \"toEmail\", status, \"scheduledAt\", attempts FROM email_jobs ORDER BY \"createdAt\" DESC LIMIT 3;"
  ```

  Three delayed jobs, three `SCHEDULED` rows, `attempts: 0`.
- **Kill it hard** — not a graceful stop, that would be too easy:

  ```bash
  pkill -9 -f "tsx watch src/index.ts"
  curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/api/health   # → 000, unreachable
  ```

  Show the dashboard failing to reach the API. Re-run the SQL: rows are still `SCHEDULED`,
  `attempts` still `0`. *"Nothing was lost, because the database — not Redis — is the source of
  truth for what has to be sent and when."*
- **Restart:**

  ```bash
  npm run dev:api
  ```

  Freeze on the reconciler's log line:

  ```
  reconcile complete  examined: 3, requeued: 0, caughtUp: 0, intact: 3, suspect: 0, durationMs: 17
  ```

  Say the important sentence: ***"`intact: 3` — it recognised the jobs were still healthy and did
  nothing. The naive implementation re-enqueues everything on boot, and that is exactly how you
  get duplicate sends after a deploy. Doing nothing here is the feature."***
- Wait for the window. All three send at their **original** times.
- Prove exactly-once:

  ```bash
  psql "$DATABASE_URL" -c "SELECT \"emailJobId\", status, \"createdAt\" FROM email_events ORDER BY \"createdAt\" DESC LIMIT 10;"
  ```

  Exactly one `PROCESSING` and one `SENT` per email, and `attempts: 1`, `rescheduleCount: 0` on
  each row. *"Nothing re-sent, nothing restarted from scratch."*

> **Redis loss.** If you have time, mention (do not necessarily perform) the second failure mode:
> flush Redis and restart, and the reconciler re-enqueues every outstanding row from its
> `scheduledAt` column — `requeued: N` instead of `intact: N`. It is covered by
> `reconciler.test.ts` → *"rebuilds the whole schedule from the database"*, which flushes Redis
> and asserts every rebuilt job fires within 1 s of its original time. Showing the test output is
> a fine substitute for wiping a live Redis on camera.

## 3:30 – 4:20 · Rate limiting (bonus)

With `MAX_EMAILS_PER_HOUR_PER_SENDER=5`:

- Schedule **8** recipients from one sender, starting immediately, delay `0`.
- Five send. The remaining three hit the cap. Show the log lines:

  ```
  hourly quota reached, deferred to next window
    emailJobId=… scope=sender target=2026-08-25T04:00:00.000Z seq=5
  ```

- Back on **Scheduled**: the three remaining rows are still there, with an amber chip showing the
  **top of the next hour** — not failed, not gone.

  ```bash
  psql "$DATABASE_URL" -c "SELECT \"toEmail\", status, \"scheduledAt\", attempts, \"rescheduleCount\" FROM email_jobs WHERE status='SCHEDULED' ORDER BY seq;"
  ```

  Three points to make out loud, pointing at the columns:
  1. **status is `SCHEDULED`, not `FAILED`** — the requirement is to delay, never to drop.
  2. **`attempts` is still 0** — being throttled is not a delivery failure and doesn't burn a
     retry.
  3. **`scheduledAt` increases with `seq`** — the target is `nextWindowStart + seq × minDelay`,
     so the batch keeps its original order across the bump.
- Optionally open Bull Board at `localhost:4000/admin/queues` to show the three jobs sitting in
  **delayed**.
- One sentence on correctness: *"the counters are a Redis Lua script that checks the global and
  per-sender caps and increments both atomically, so the limit holds across any number of worker
  processes — not an in-memory counter that would multiply by the number of instances."*

## 4:20 – 5:00 · Scale, tests, close

- Load behaviour:

  ```bash
  npm run load-test -- --count 1200 --hourly-limit 200
  ```

  Show the printed drain projection — 200 in the first window, the remainder rolling into the
  next five, in order.
- Tests:

  ```bash
  npm test
  ```

  `Test Files 7 passed (7) · Tests 107 passed (107)`. *"Against real Redis and real Postgres, not
  mocks — the properties being tested are properties of those systems."* Let the suite names be
  visible: idempotency, rate-limiter, throttling, reconciler.
- Health endpoint as the closing shot:

  ```bash
  curl -s localhost:4000/api/health | jq .data.config
  ```

  *"It echoes the live tuning knobs, so nothing in this demo depends on you taking my word for
  what was configured."*
- Close on the honest note: *"no cron anywhere — scheduling is BullMQ delayed jobs; the only
  interval in the system is a self-healing repair sweep that can be switched off, and there's a
  test proving scheduling still works when it is."*

---

## If you have to cut

Cut in this order — 4:20–5:00 first, then trim the compose walkthrough to a single upload and
submit. **Never cut 2:10–3:30.** The restart scenario is explicitly named in the brief and is the
segment that distinguishes a working scheduler from a queue demo.
