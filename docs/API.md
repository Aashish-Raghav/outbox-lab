# API reference

Base URL `http://localhost:4000`. The dashboard talks to it through a Next.js rewrite at
`/api/*` on port 3000, so the session cookie stays same-origin — see
[Why the rewrite](#why-the-dashboard-proxies-the-api) at the bottom.

Every request and response body is validated by a zod schema in
[`packages/shared/src/schemas.ts`](../packages/shared/src/schemas.ts), which both apps import.
That is the actual contract; this document is a readable rendering of it.

## Conventions

- **Success** → `{ "data": <payload> }`
- **Failure** → `{ "error": { "code": "...", "message": "...", "details": ..., "requestId": "..." } }`
- **Auth** → an httpOnly cookie (`reachinbox_session`) holding a signed JWT. Send
  `credentials: 'include'`.
  Everything except `/api/health` and `/api/auth/*` requires it.
- **Timestamps** are ISO 8601 strings in UTC.
- **Rate limits** — a general limiter on `/api`, a stricter one on `/api/auth/*`, and a stricter
  one still on campaign creation. Exceeding one returns `429`.

| Status | When |
|---|---|
| `400` | Zod validation failed (`details` carries the field errors), or the requested state transition is not legal — e.g. cancelling an email that already sent. |
| `401` | No session cookie, or it is expired/forged. |
| `403` | The demo login path is disabled. |
| `404` | No such row. A row owned by another user returns this too, deliberately: ownership is a `WHERE userId = …` predicate, so the API cannot confirm that someone else's id exists. |
| `409` | A uniqueness constraint was violated. |
| `413` | Upload exceeded `MAX_UPLOAD_BYTES`. |
| `429` | Rate limited. |
| `503` | `/api/health` only — a dependency is down. |

---

## Auth

### `GET /api/auth/config`

Unauthenticated. Lets the login screen render honestly instead of showing a Google button the
server cannot verify a token for.

```json
{ "data": {
  "googleEnabled": true,
  "googleClientId": "xxxx.apps.googleusercontent.com",
  "passwordLoginEnabled": true,
  "demoEmail": "demo@reachinbox.ai"
} }
```

### `POST /api/auth/google`

```json
{ "credential": "<Google Identity Services ID token>" }
```

Verifies the token against Google's public keys with `verifyIdToken`, upserts the user by their
stable `sub` claim, sets the session cookie, and returns `{ "data": { "user": … } }`.

### `POST /api/auth/password`

```json
{ "email": "demo@reachinbox.ai", "password": "demo1234" }
```

The demo path. Returns `403` when `ALLOW_PASSWORD_LOGIN=false`, and the server refuses to enable
it at all under `NODE_ENV=production`.

### `GET /api/auth/me`

Returns the signed-in user, or `401`. The dashboard treats a `401` here as "signed out", not as
an error, so a logged-out visitor sees the login page rather than an error card.

### `POST /api/auth/logout`

Clears the cookie with the same attributes it was set with — omit them and the browser keeps it.

---

## Senders

### `GET /api/senders`

Populates the Compose screen's `From` dropdown, with live quota so a user can see *before*
scheduling that a mailbox is nearly capped.

```json
{ "data": [{
  "id": "…", "name": "Ava Sender", "fromEmail": "ava@ethereal.email",
  "isActive": true, "maxEmailsPerHour": null,
  "usedThisHour": 37, "limitThisHour": 100,
  "globalUsedThisHour": 118, "globalLimitThisHour": 200,
  "windowResetsAt": "2026-08-25T04:00:00.000Z"
}] }
```

SMTP credentials are deliberately absent from the response. `maxEmailsPerHour: null` means the
sender inherits `MAX_EMAILS_PER_HOUR_PER_SENDER`.

---

## Campaigns

### `POST /api/campaigns`

`multipart/form-data`, because it can carry a lead list and attachments. Every scalar therefore
arrives as a string, which is why the schema uses `z.coerce` on the numeric and date fields.

| Field | Type | Notes |
|---|---|---|
| `senderId` | string | Required. |
| `subject` | string | Required, ≤ 500 chars. |
| `bodyHtml` | string | Required. Sanitised server-side before storage. |
| `recipients` | JSON array, repeated field, or a `,`/`;`/newline blob | Merged with the uploaded file. |
| `startAt` | ISO datetime | Omit to send as soon as the queue allows. |
| `delayBetweenSeconds` | integer 0–3600 | The Figma's *"Delay between 2 emails"*. |
| `hourlyLimit` | integer 0–100000 | The Figma's *"Hourly Limit"*. `0` = use the server default. Cannot raise a limit above the sender's own. |
| `leads` | file (CSV/TXT) | Parsed, then deleted from disk immediately. |
| `attachments` | file[] | Stored under `UPLOAD_DIR`. |

Send `recipients` as a **JSON array** when an address could contain a comma; the delimiter
fallback would otherwise split it.

```
201 Created
{ "data": {
  "campaign": { "id": "…", "subject": "…", "status": "SCHEDULED", "startAt": "…",
                "delayBetweenMs": 3000, "hourlyLimit": 200, "totalRecipients": 4,
                "createdAt": "…", "sender": { "id": "…", "name": "…", "fromEmail": "…" } },
  "recipientsAccepted": 4,
  "duplicatesRemoved": 2,
  "invalidSkipped": ["not-an-email"],
  "projectedCompletionAt": "2026-08-25T03:12:09.000Z",
  "windowsRequired": 1,
  "throttledByHourlyLimit": false
} }
```

`duplicatesRemoved` counts both duplicates *within* the uploaded file and duplicates *between*
the file and the typed addresses — counting only one under-reports what was dropped.
`invalidSkipped` exists so a wrong column in a CSV produces a readable message rather than a
silently short campaign.

`projectedCompletionAt` / `windowsRequired` / `throttledByHourlyLimit` come from
`projectCampaign()` in the shared package — the same function the Compose form runs client-side,
so the "this batch will span 5 hours" warning shown before submit is the server's own arithmetic.

### `GET /api/campaigns`

The 50 most recent campaigns for the signed-in user, each with `counts: { scheduled, sent,
failed }`. The counts come from one grouped query for all campaigns rather than one query per
row.

---

## Emails

### `GET /api/emails`

| Query | Values | Default |
|---|---|---|
| `mailbox` | `scheduled` \| `sent` | — |
| `status` | `SCHEDULED` `QUEUED` `PROCESSING` `SENT` `FAILED` `CANCELLED` | — |
| `search` | ≤ 200 chars; matches recipient or subject | — |
| `starred` | `true` \| `false` | — |
| `page` | ≥ 1 | `1` |
| `limit` | 1–100 | `25` |

`mailbox` is the tab-level grouping: `scheduled` covers `SCHEDULED + QUEUED + PROCESSING`,
`sent` covers `SENT + FAILED`. `status` narrows within it.

```json
{ "data": {
  "items": [{
    "id": "…", "campaignId": "…", "toEmail": "john@example.com",
    "subject": "Quick question", "preview": "Hi John, I noticed…",
    "status": "SCHEDULED", "scheduledAt": "…", "sentAt": null,
    "attempts": 0, "rescheduleCount": 0, "lastError": null,
    "previewUrl": null, "isStarred": false,
    "sender": { "id": "…", "name": "…", "fromEmail": "…" }
  }],
  "pagination": { "page": 1, "limit": 25, "total": 785, "totalPages": 32, "hasNext": true }
} }
```

`preview` is the plain-text snippet for the greyed-out half of a list row — computed server-side
so the client never has to strip HTML.

### `GET /api/emails/:id`

The list shape plus `bodyHtml`, `attachments[]` and `createdAt`. `rescheduleCount`, `attempts`
and `lastError` are surfaced in the detail view's audit block; `previewUrl` links to the
delivered message on Ethereal.

### `POST /api/emails/:id/cancel`

Moves the row to `CANCELLED`, writes an audit event, then removes the delayed BullMQ job — in
that order, so a worker that picks the job up in the gap hits the terminal-state short-circuit
instead of sending it.

Returns `400 VALIDATION_ERROR` (*"That email has already been sent"*) for an email that already
went out — a sent email cannot be un-sent, and the API says so rather than pretending. Cancelling
an already-cancelled email is a no-op that returns `200`, so a double-click is harmless.

### `PATCH /api/emails/:id/star`

```json
{ "isStarred": true }
```

The dashboard applies this optimistically and rolls back from a snapshot on error.

### `GET /api/stats`

```json
{ "data": { "scheduled": 12, "sent": 785, "failed": 0 } }
```

Drives the sidebar counts. The dashboard hides them until they are known — a `0` that flips to
`785` reads as a bug.

---

## Operations

### `GET /api/health`

Unauthenticated: a health check that needs a session is useless to a load balancer. Returns
`503` when a dependency is down, so an orchestrator stops routing here rather than getting a
cheerful `200` from a scheduler that cannot reach Redis.

```json
{ "data": {
  "status": "ok",
  "uptimeSeconds": 431,
  "checks": { "database": true, "redis": true },
  "queue": { "waiting": 0, "active": 1, "delayed": 1196, "completed": 204, "failed": 0 },
  "events": { … },
  "config": {
    "workerConcurrency": 5,
    "minDelayBetweenSendsMs": 2000,
    "maxEmailsPerHour": 200,
    "maxEmailsPerHourPerSender": 100,
    "reconcileIntervalMs": 300000
  }
} }
```

Echoing the tuning knobs makes a demo self-documenting — the configured limits are visible
without anyone reading a `.env` on camera.

### `GET /admin/queues`

Bull Board, mounted **in development only**. Useful for watching the delayed set drain during
the rate-limit demo.

---

## Why the dashboard proxies the API

`next.config.mjs` rewrites `/api/:path*` to `http://localhost:4000/api/:path*`.

The session is an httpOnly cookie. Going straight from `localhost:3000` to `localhost:4000`
would make it cross-origin, requiring `SameSite=None` plus a secure context — cookie gymnastics
that exist only because of the port split in development and that would not reflect how this is
deployed. Proxying keeps every request same-origin, so the cookie behaves in development exactly
as it does behind one domain in production.
