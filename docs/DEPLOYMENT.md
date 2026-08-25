# Deployment

The app runs on Google Cloud Run in project `aashish-test-project-01`, region
`us-central1`.

| | URL |
|---|---|
| Dashboard | https://reachinbox-web-522727866437.us-central1.run.app |
| API | https://reachinbox-api-522727866437.us-central1.run.app |
| Health | https://reachinbox-api-522727866437.us-central1.run.app/api/health |

Deployment is **not** a requirement of the assignment — the graded deliverables
are the repository, the README and the demo video. This exists because a live
URL is easier to review than a local checkout.

## Topology

```
                    ┌──────────────────────────────┐
  browser ────────► │ reachinbox-web (Cloud Run)   │
                    │ Next 15, next start          │
                    │ /api/* ──rewrite──┐          │
                    └───────────────────┼──────────┘
                                        │  public HTTPS
                    ┌───────────────────▼──────────┐
                    │ reachinbox-api (Cloud Run)   │
                    │ Express + BullMQ worker      │
                    │ min-instances=1, CPU always  │
                    └───────────────┬──────────────┘
                                    │ Direct VPC egress
                                    │ subnet-cloudrun 192.168.16.0/26
                    ┌───────────────▼──────────────┐
                    │ custom-vpc                   │
                    │ GCE VM 192.168.1.2           │
                    │  ├── PostgreSQL 17 :5432     │
                    │  └── Redis 7 :6379 (AOF)     │
                    └──────────────────────────────┘
```

### Why this shape

**Cloud Run for compute.** Beyond the usual reasons, it hands out an
`https://….run.app` URL. Google OAuth requires authorized JavaScript origins to
be HTTPS on a real domain — it rejects bare IPs — so a plain VM with an external
IP could not have done real Google login without also buying a domain and
terminating TLS.

**`--min-instances=1 --no-cpu-throttling` on the API is load-bearing, not
tuning.** Cloud Run's default is to throttle CPU to near zero between requests
and scale to zero when idle. The BullMQ worker runs in-process and fires on a
timer, not on a request; under the default settings a delayed job would simply
never run until something happened to hit the service. These two flags are what
make a queue worker viable on Cloud Run at all.

**`--max-instances=3`.** Concurrency safety is enforced in Redis and Postgres,
not by running a single instance — the atomic claim and the Lua quota script are
correct across any number of workers. The cap is a cost guard.

**Datastores on the existing VM.** Chosen over Cloud SQL + Memorystore (~$45/mo)
because they were already installed, configured and verified here, and because
Memorystore offers no AOF — only periodic snapshots. Keeping Redis on the VM
preserves the real `appendonly yes` durability story the architecture is built
around. The trade-off is honest and significant: **if this VM is stopped or
deleted, the deployment loses both datastores.** It is a demo, not a production
posture.

**Secrets.** `DATABASE_URL`, `REDIS_URL` and `JWT_SECRET` are Secret Manager
references (`--set-secrets`), not plain env vars, so they are not readable from
the service description. Everything else is non-sensitive configuration and is
set with `--set-env-vars`.

**Isolation from dev.** Production uses a separate Postgres role and database
(`reachinbox_prod`) and a separate `QUEUE_PREFIX=reachinbox-prod`. The prefix
matters more than it looks: it namespaces the BullMQ keys *and* the rate-limiter
keys (`{prefix}:rl:global:{window}`), so dev traffic on the same Redis cannot
consume production's hourly quota.

## What is provisioned

| Resource | Name |
|---|---|
| Cloud Run service | `reachinbox-api`, `reachinbox-web` |
| Artifact Registry | `reachinbox` (us-central1) |
| Secret Manager | `reachinbox-database-url`, `reachinbox-redis-url`, `reachinbox-jwt-secret` |
| Subnet | `subnet-cloudrun` — 192.168.16.0/26, for Direct VPC egress |
| Firewall | `allow-cloudrun-to-datastores` — tcp:5432,6379 from 192.168.16.0/26 to tag `reachinbox-datastore` only |
| VM tag | `reachinbox-datastore` on `instance-20260824-120039` |
| Postgres | role + database `reachinbox_prod`, listening on 192.168.1.2 |
| Redis | bound to 192.168.1.2, `requirepass` set |

Redis was reachable only on loopback before this and had no password. It is now
reachable from one /26 inside one VPC, and requires auth — the firewall is the
primary control and the password is defence in depth.

## Rebuilding and redeploying

`gcloud run deploy --source` cannot be used: it expects a Dockerfile at the root
of the build context, and this is a monorepo producing two images from one
context (npm workspaces need the root lockfile, so the context cannot be
narrowed). [`cloudbuild.yaml`](../cloudbuild.yaml) parameterises the Dockerfile
path instead.

```bash
# API
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_IMAGE=us-central1-docker.pkg.dev/aashish-test-project-01/reachinbox/api:vN,_DOCKERFILE=apps/api/Dockerfile
gcloud run deploy reachinbox-api --region us-central1 \
  --image us-central1-docker.pkg.dev/aashish-test-project-01/reachinbox/api:vN

# Dashboard — API_ORIGIN must be the API's real URL, see below
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_IMAGE=us-central1-docker.pkg.dev/aashish-test-project-01/reachinbox/web:vN,_DOCKERFILE=apps/web/Dockerfile,_API_ORIGIN=https://reachinbox-api-522727866437.us-central1.run.app
gcloud run deploy reachinbox-web --region us-central1 \
  --image us-central1-docker.pkg.dev/aashish-test-project-01/reachinbox/web:vN
```

**`API_ORIGIN` is a build-time value for the dashboard.** Next resolves
`rewrites()` while loading the config and bakes the result into
`routes-manifest.json`, so passing it only at runtime leaves the `/api/*` proxy
pointing at `localhost:4000`. It is set in both stages of the Dockerfile so
either resolution order lands on the same origin.

Config-only changes need no rebuild:

```bash
gcloud run services update reachinbox-api --region us-central1 \
  --update-env-vars MAX_EMAILS_PER_HOUR_PER_SENDER=5
```

Database migrations are run from the VM over loopback, not from a container:

```bash
DATABASE_URL='postgresql://reachinbox_prod:…@127.0.0.1:5432/reachinbox_prod' \
  npx --workspace @reachinbox/api prisma migrate deploy
```

## Google OAuth

The API refuses to boot in production without `GOOGLE_CLIENT_ID`, and refuses to
enable the demo password login at all — see the `superRefine` block in
`apps/api/src/config/env.ts`. Real Google login is the only way in.

Create an **OAuth 2.0 Client ID (Web application)** with authorized JavaScript
origin `https://reachinbox-web-522727866437.us-central1.run.app`. No redirect URI
and no client secret: the GIS ID-token flow checks the origin, and the token is
verified server-side with `google-auth-library`.

Applying it is an env-var update, not a rebuild — the dashboard reads the client
id from `GET /api/auth/config` at runtime rather than baking it into the bundle:

```bash
gcloud run services update reachinbox-api --region us-central1 \
  --update-env-vars GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
```

## Three bugs this shook out

Containerising the app exercised paths local development never had, and found
real defects — two of which affect anyone running the project, not just this
deployment.

1. **`tsc` does not copy `hourly-quota.lua` into `dist/`.** Dev runs from `src/`
   through `tsx` and never noticed; any real build crashed at boot with `ENOENT`
   on `dist/ratelimit/hourly-quota.lua`. `npm run build && npm start` was broken
   on any machine. Fixed in the API's `build` script.
2. **npm does not hoist every workspace dependency.** `@bull-board/express` pins
   an Express version that conflicts with the root-hoisted Express 4, so npm
   leaves ~19 packages in a nested `apps/api/node_modules`. A runtime stage that
   copies only the root `node_modules` fails with `ERR_MODULE_NOT_FOUND`.
3. **`next start -p 3000` ignores Cloud Run's `$PORT`.** The container would
   have failed its startup probe. The Dockerfile overrides the package script.

## Known limitations

- **Uploads are ephemeral.** `UPLOAD_DIR` is a path in Cloud Run's in-memory,
  per-instance filesystem. Attachments do not survive a restart and are not
  shared between instances. Production would use a GCS bucket; lead-list CSVs
  are parsed on upload and persisted as `EmailJob` rows, so those are unaffected.
- **The deployment depends on this VM** for both datastores, as above.
- **Single region, no backups.** Postgres has no automated backup configured.
- **The API is public** (`--allow-unauthenticated`). It has to be — the browser
  reaches it through the dashboard's proxy. Authentication is the app's own JWT
  session cookie, and `express-rate-limit` sits in front of the routes.

## Teardown

```bash
bash scripts/gcp-teardown.sh              # dry run, prints what it would delete
bash scripts/gcp-teardown.sh --yes        # delete the Google Cloud resources
bash scripts/gcp-teardown.sh --yes --revert-vm   # also drop reachinbox_prod and
                                                 # restore the VM to loopback-only
```

`--revert-vm` is separate because it destroys the production database and
removes the Redis password, which is not recoverable — whereas the Cloud Run
side can be redeployed from the images at any time.
