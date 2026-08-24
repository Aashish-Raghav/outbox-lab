#!/usr/bin/env bash
#
# Brings up PostgreSQL and Redis without Docker.
#
# `docker-compose.yml` is the primary path and is what the README recommends.
# This script exists because Docker is not always available — it was not in the
# environment this project was built in — and the reviewer should not be blocked
# on that. It uses the distro packages and configures the two things this
# service actually depends on:
#
#   * Redis with AOF persistence, so delayed jobs survive a Redis restart
#   * Redis with `noeviction`, so a memory ceiling can never silently drop a
#     queued email (the default `volatile-lru` would)
#
# Usage:
#   bash scripts/dev-services.sh install   # apt-get redis + postgres
#   bash scripts/dev-services.sh up        # start, configure, create databases
#   bash scripts/dev-services.sh status    # show what is running
#   bash scripts/dev-services.sh down      # stop both
#
set -euo pipefail

DB_NAME="${DB_NAME:-reachinbox}"
DB_TEST_NAME="${DB_TEST_NAME:-reachinbox_test}"
DB_USER="${DB_USER:-reachinbox}"
DB_PASS="${DB_PASS:-reachinbox}"
PG_VERSION="${PG_VERSION:-17}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }

require_sudo() {
  if ! sudo -n true 2>/dev/null; then
    red "This step needs sudo. Re-run with a sudo-capable account."
    exit 1
  fi
}

cmd_install() {
  require_sudo
  yellow "Installing redis-server and postgresql-${PG_VERSION}…"
  sudo apt-get update -qq
  sudo apt-get install -y -qq redis-server "postgresql-${PG_VERSION}"
  green "Installed."
}

start_redis() {
  if redis-cli ping >/dev/null 2>&1; then
    green "Redis already running."
  else
    yellow "Starting Redis…"
    require_sudo
    sudo redis-server \
      --daemonize yes \
      --appendonly yes \
      --appendfsync everysec \
      --maxmemory-policy noeviction \
      --dir /var/lib/redis
    sleep 1
  fi

  # Applied every time: a Redis started by some other means (a service unit, a
  # previous run of this script, a colleague's terminal) may not have them, and
  # both settings are correctness-relevant rather than cosmetic.
  redis-cli config set appendonly yes >/dev/null
  redis-cli config set maxmemory-policy noeviction >/dev/null

  green "Redis ready — AOF: $(redis-cli config get appendonly | tail -1), eviction: $(redis-cli config get maxmemory-policy | tail -1)"
}

start_postgres() {
  if pg_isready -q 2>/dev/null; then
    green "PostgreSQL already running."
  else
    yellow "Starting PostgreSQL ${PG_VERSION}…"
    require_sudo
    sudo pg_ctlcluster "${PG_VERSION}" main start 2>/dev/null || sudo service postgresql start
    for _ in $(seq 1 20); do
      pg_isready -q 2>/dev/null && break
      sleep 0.5
    done
  fi

  pg_isready -q || { red "PostgreSQL did not come up."; exit 1; }
  green "PostgreSQL ready."
}

provision_database() {
  require_sudo
  yellow "Ensuring role and databases exist…"

  # Idempotent: safe to re-run on an already-provisioned machine.
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
    || sudo -u postgres psql -q -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}' CREATEDB"

  for db in "${DB_NAME}" "${DB_TEST_NAME}"; do
    sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1 \
      || sudo -u postgres psql -q -c "CREATE DATABASE ${db} OWNER ${DB_USER}"
  done

  green "Databases ready: ${DB_NAME}, ${DB_TEST_NAME}"
  cat <<EOF

Put these in .env:

  DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}
  TEST_DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_TEST_NAME}
  REDIS_URL=redis://127.0.0.1:6379

Then: npm run db:migrate && npm run provision:ethereal
EOF
}

cmd_status() {
  if redis-cli ping >/dev/null 2>&1; then
    green "redis      up   (aof=$(redis-cli config get appendonly | tail -1), policy=$(redis-cli config get maxmemory-policy | tail -1), keys=$(redis-cli dbsize))"
  else
    red "redis      down"
  fi

  if pg_isready -q 2>/dev/null; then
    green "postgres   up   ($(pg_isready | head -1))"
  else
    red "postgres   down"
  fi
}

cmd_down() {
  require_sudo
  redis-cli shutdown nosave 2>/dev/null || true
  sudo pg_ctlcluster "${PG_VERSION}" main stop 2>/dev/null || sudo service postgresql stop || true
  green "Stopped."
}

case "${1:-up}" in
  install) cmd_install ;;
  up)      start_redis; start_postgres; provision_database ;;
  status)  cmd_status ;;
  down)    cmd_down ;;
  *)       red "Unknown command: $1"; echo "Usage: $0 {install|up|status|down}"; exit 1 ;;
esac
