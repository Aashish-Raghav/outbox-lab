# syntax=docker/dockerfile:1
#
# API + worker image. Build context is the REPO ROOT, not this directory —
# npm workspaces resolve @reachinbox/shared through the root lockfile, so a
# context rooted at apps/api could not install anything.
#
#   docker build -f apps/api/Dockerfile .
#
# `node:20-slim` rather than `-alpine`: Prisma's query engine is built against
# glibc, and the musl build needs an extra binaryTarget. Slim avoids that whole
# class of "works locally, segfaults in the container" problem.

# ─── build ───────────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# Prisma's generate step shells out to openssl to pick a query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# Manifests first, so the dependency layer is cached and only reinstalls when a
# package.json or the lockfile actually changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# --ignore-scripts is load-bearing. The root `prepare` script builds the shared
# package and runs `prisma generate`, and npm fires it during `npm ci` — before
# the COPY below has put any source in the image. Left enabled it fails the
# build. Both steps are run explicitly further down instead.
RUN npm ci --ignore-scripts

COPY . .

RUN npm run build -w @reachinbox/shared \
  && npx --workspace @reachinbox/api prisma generate \
  && npm run build -w @reachinbox/api

# npm hoists most workspace dependencies to the root, but not all of them:
# @bull-board/express pins an Express version that conflicts with the
# root-hoisted Express 4, so npm leaves ~19 packages in a nested
# apps/api/node_modules. The runtime stage has to copy that tree as well, and
# COPY fails on a path that does not exist — so guarantee it exists.
RUN mkdir -p /app/apps/api/node_modules

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# node_modules carries both the generated Prisma client (.prisma/client) and the
# workspace symlink @reachinbox/shared -> ../../packages/shared, which is why
# packages/shared has to be copied too or the symlink dangles at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma

# Attachment and lead-list uploads. Cloud Run's filesystem is in-memory and
# per-instance, so this is scratch space, not storage — see docs/DEPLOYMENT.md.
RUN mkdir -p /app/apps/api/uploads && chown -R node:node /app/apps/api/uploads
USER node

WORKDIR /app/apps/api

# Cloud Run injects PORT (8080 by default) and the app's zod env schema reads it.
EXPOSE 8080
CMD ["node", "dist/index.js"]
