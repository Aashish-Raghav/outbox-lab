# Assumptions, trade-offs and shortcuts

Everything here is a decision that could reasonably have gone the other way. Each entry says what
was chosen, what it costs, and what would change it. Nothing in this file is an apology — it is
the list a reviewer would otherwise have to reverse-engineer from the code.

---

## Interpretation of the brief

**"Minimum delay between sends" is global, not per campaign.** The brief lists it alongside worker
concurrency as a worker-level knob, so `MIN_DELAY_BETWEEN_SENDS_MS` paces the whole fleet via
BullMQ's Redis-backed limiter. The Compose screen's *"Delay between 2 emails"* is a separate,
per-campaign control baked into each row's `scheduledAt`. Both exist because they answer different
questions: one is *"don't hammer the SMTP provider"*, the other is *"this outreach sequence should
feel human"*.

**Hour windows are fixed wall-clock hours, not a sliding window.** `floor(now / 3600000)` — so the
quota resets at the top of every hour. A sliding window is more accurate against a provider's
actual policy, but "the next available hour" becomes fuzzy, and the reschedule target stops being
a stable value two workers can independently compute. Fixed windows also make the Lua script
trivial: two `INCR`s and a TTL, with no sorted set to trim. Cost: up to 2× the nominal rate across
a window boundary (the last minute of one hour and the first of the next). For an outreach tool
with a two-second floor between sends, that is not the constraint that matters.

**The dashboard shows *emails*, not campaigns.** The Figma's Scheduled and Sent tabs are per-email
lists, so `EmailJob` is the unit the UI works in. `Campaign` exists as the grouping and is exposed
at `GET /api/campaigns`, but there is no campaign management screen — the design does not show one.

**"Sent" includes `FAILED`.** A failed email has left the Scheduled tab and must be visible
somewhere; the design has only two tabs. It appears in Sent with a red status chip and its error
text, rather than vanishing.

---

## Deliberate trade-offs

### Indeterminate sends fail closed

A worker can die *after* SMTP accepts a message but *before* the `SENT` row commits. Nothing
inside the system can tell which side of the handoff it died on.

**Chosen:** `RESEND_SUSPECT_JOBS=false`. The row is marked `FAILED` with an explicit
`lastError` explaining that delivery is indeterminate and why it was not retried.

**Why:** the brief's hard requirement is *never send twice*, and the two failure modes are not
symmetric. A missed email is visible in the dashboard with its reason, and a human can resend it.
A duplicate has already landed in a prospect's inbox and cannot be recalled.

**Cost:** a rare email that did *not* actually send is reported as failed and needs a manual
resend. **Flip it** with `RESEND_SUSPECT_JOBS=true` if your domain would rather have the duplicate.

### Quota is reserved before the send and not refunded

**Chosen:** reserve, then send; `RATE_LIMIT_REFUND_ON_FAILURE=false`.

**Why:** a crash can then only ever *under*-use the allowance. Reserving after a successful send
means a crash mid-send leaves the counter un-incremented, and a retry can push the real send count
past the provider's limit — which is how a sending domain gets throttled or blocked.

**Cost:** failed sends consume quota that could have been reused. Set the flag to `true` to
prioritise throughput.

### Sender failover is off by default

`SENDER_FAILOVER=true` re-routes a capped job to another sender with spare quota. It is off
because for cold outreach the From address is part of the campaign's identity, and quietly sending
from a different mailbox is usually the wrong answer. For transactional mail it is obviously the
right answer — hence a flag rather than a hardcoded decision.

### The worker runs inside the API by default

`RUN_WORKER_IN_API=true` so `npm run dev` boots the whole system with one command. Production
should set it `false` and scale `npm run start:worker` separately. This is safe to change at any
time precisely because the claim and the quota are atomic and Redis/DB-backed — the topology is a
deployment choice, not a design constraint.

### Ordering is preserved *best-effort*, not guaranteed

Within a campaign, `scheduledAt = startAt + seq × delay` and reschedule targets are
`nextWindowStart + seq × minDelay`, so relative order survives both the initial schedule and a
throttle bump. But with `WORKER_CONCURRENCY > 1`, five jobs are in flight simultaneously and SMTP
round-trip times vary, so two emails scheduled 50 ms apart can complete out of order. Strict
global ordering would mean concurrency 1, which is a far bigger cost than it is worth. The brief
asks for order to be preserved *as much as possible*, which is what is implemented.

---

## Security and data handling

- **Ethereal SMTP passwords are stored in plain columns.** These are disposable test inboxes with
  nothing behind them. A real deployment would store a KMS/secret-manager reference in that column
  instead; the schema comment says so at the field. Flagged rather than hidden.
- **`GET /api/senders` never returns credentials** — only the identity and the live quota.
- **Email bodies are sanitised with `sanitize-html` before storage**, not just before rendering.
  The stored value is the safe one, so anything that later reads the row (the API, the dashboard's
  `dangerouslySetInnerHTML`, the SMTP payload) is safe by construction rather than by remembering
  to sanitise at each site.
- **Uploaded lead lists are parsed and then deleted immediately.** The address list is never
  retained on disk.
- **Attachments *are* retained** on the local filesystem under `UPLOAD_DIR`, because they have to
  be re-read at send time, which may be hours after upload. S3 is the obvious swap — the row
  already stores an opaque `storagePath`.
- **The demo password login** is a fixed credential pair from `.env`, compared directly. It is not
  a user system: there is no registration, no hashing, no reset. It exists so the dashboard can be
  reviewed before anyone provisions a Google client ID, and the API refuses to enable it when
  `NODE_ENV=production`.
- **Sessions are httpOnly JWT cookies** with a 7-day expiry and no refresh-token rotation. Adequate
  for this scope; a production system would want rotation and revocation.
- **Ownership is enforced as a `WHERE userId = …` predicate on every query**, so a row belonging to
  another user returns `404`, not `403` — the API cannot confirm that someone else's id exists.

---

## Not built (and why)

All of these are out of scope for the brief. Listed so their absence is a decision rather than an
oversight:

| Not built | Note |
|---|---|
| Unsubscribe / list-management | Legally required for real outreach; nothing to do with the scheduling problem being assessed. |
| Bounce and complaint webhooks | Ethereal never bounces, so there would be nothing to test against. |
| Open / click tracking | Needs a public pixel/redirect endpoint — a separate service. |
| Template variables (`{{firstName}}`) | The lead parser already keeps per-row context; this is the natural next feature. |
| Timezone-aware "send at 9am *their* time" | Would need a timezone per lead. `startAt` is a single absolute instant. |
| Multi-tenant organisations | Every row is scoped to one `userId`; teams would need an org layer. |
| Campaign pause/resume | Individual emails can be cancelled. Bulk operations are a straightforward extension of the same mechanics. |
| Draft saving | Compose state is not persisted until submit. |

---

## Environment and verification limits

Three things could not be done from inside the build environment. Each has a written substitute
rather than a silent gap.

**Docker was not available**, so `docker-compose.yml` ships the datastores only — PostgreSQL and
Redis with the AOF and `noeviction` flags the system actually depends on. Adding `api`/`worker`/
`web` images would have meant shipping Dockerfiles that were never built, presented as if they
worked. The npm workflow in the README is the one that was verified end to end. The reasoning is
repeated at the top of the compose file so it is found by whoever reaches for it first.

**The GitHub repository could not be created** — no `gh` CLI and no credentials. The exact
commands, including granting access to `Mitrajit` and `Yadav036`, are in the README under
[Pushing to GitHub](../README.md#pushing-to-github).

**The demo video could not be recorded.** [DEMO_SCRIPT.md](DEMO_SCRIPT.md) is a shot-by-shot
script with timings covering scheduling, the dashboard, the restart scenario and the rate-limit
bonus, written so it can be followed literally.

**Google OAuth was verified structurally, not interactively** — no Google client ID existed in
this environment. The ID-token verification path, the config endpoint, the session cookie and the
guard are all exercised by the test suite and by the demo login path; the Google button appears
and works the moment `GOOGLE_CLIENT_ID` is set. The two-minute Cloud Console setup is in the
README.

**`npm audit` reports 8 findings.** They split into two groups, and neither is reachable here:

- **five in the test runner** — `vitest`, `vite`, `vite-node`, `@vitest/mocker`, `esbuild`. All are
  dev dependencies, and all describe attacks against a *running dev/UI server* (`esbuild`'s
  permissive dev-server CORS, Vitest UI arbitrary file read). Nothing ships to production and no
  such server is exposed.
- **three under `next`** — its bundled `postcss` and its optional `sharp`. `postcss` runs at build
  time on our own stylesheets, not on untrusted CSS. `sharp` backs `next/image`, which this app
  deliberately does not use: avatar hosts are user-controlled and `next/image` would require
  allow-listing every one of them (see the comment in `Avatar.tsx`).

The only clean fix for the `next` group is `npm audit fix --force`, which installs Next 16 — a
major version bump on the day of submission, to close two paths the app does not execute. That
is a worse trade than the finding. Left as-is, documented rather than force-resolved.
