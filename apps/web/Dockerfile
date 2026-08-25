# syntax=docker/dockerfile:1
#
# Dashboard image. Build context is the REPO ROOT — see apps/api/Dockerfile for
# why.
#
#   docker build -f apps/web/Dockerfile --build-arg API_ORIGIN=https://… .

# ─── build ───────────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# See apps/api/Dockerfile — the root `prepare` script cannot run before source
# exists in the image.
RUN npm ci --ignore-scripts

COPY . .

# next.config.mjs reads API_ORIGIN to build the /api/* rewrite. Next resolves
# rewrites while loading the config, and bakes them into routes-manifest.json
# during the build, so this has to be present at BUILD time — a runtime-only
# value would silently leave the proxy pointing at localhost:4000. It is also
# set in the runtime stage, so both resolution orders land on the same origin.
ARG API_ORIGIN=http://localhost:4000
ENV API_ORIGIN=${API_ORIGIN}

RUN npm run build -w @reachinbox/shared \
  && npm run build -w @reachinbox/web

# See apps/api/Dockerfile — npm does not hoist every workspace dependency to the
# root, and COPY fails on a path that does not exist. The dashboard happens to
# hoist cleanly today, but that is a property of the current lockfile, not a
# guarantee, and this costs nothing.
RUN mkdir -p /app/apps/web/node_modules

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

ARG API_ORIGIN=http://localhost:4000
ENV API_ORIGIN=${API_ORIGIN}

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/next.config.mjs ./apps/web/next.config.mjs
COPY --from=build /app/apps/web/.next ./apps/web/.next

USER node
WORKDIR /app/apps/web

# The package script pins `-p 3000`, but Cloud Run assigns the port through
# $PORT and health-checks that port only. Shell form so $PORT expands at
# container start rather than being passed through as a literal.
EXPOSE 8080
CMD ["sh", "-c", "npx next start -p ${PORT:-3000}"]
