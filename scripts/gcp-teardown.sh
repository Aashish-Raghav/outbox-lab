#!/usr/bin/env bash
#
# Deletes everything `docs/DEPLOYMENT.md` creates, so the billing stops with one
# command once the review is done.
#
#   bash scripts/gcp-teardown.sh              # dry run, prints what it would do
#   bash scripts/gcp-teardown.sh --yes        # delete the Google Cloud resources
#   bash scripts/gcp-teardown.sh --yes --revert-vm   # also undo the VM datastore changes
#
# The VM changes are behind a separate flag on purpose. Reverting them takes the
# production database and the Redis password with it, which is unrecoverable —
# whereas the Cloud Run side can simply be redeployed from the images.
set -uo pipefail

PROJECT="${PROJECT:-aashish-test-project-01}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
VM="${VM:-instance-20260824-120039}"
NETWORK="${NETWORK:-custom-vpc}"

APPLY=false
REVERT_VM=false
for arg in "$@"; do
  case "$arg" in
    --yes) APPLY=true ;;
    --revert-vm) REVERT_VM=true ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

# Every destructive call goes through here, so the dry run is honest by
# construction rather than by remembering to guard each line.
run() {
  if [ "$APPLY" = true ]; then
    echo "+ $*"
    "$@" 2>&1 | tail -2
  else
    echo "  would run: $*"
  fi
}

[ "$APPLY" = true ] || yellow "DRY RUN — nothing will be deleted. Re-run with --yes to apply."
echo
green "Cloud Run services"
run gcloud run services delete reachinbox-web --region="$REGION" --project="$PROJECT" --quiet
run gcloud run services delete reachinbox-api --region="$REGION" --project="$PROJECT" --quiet

echo
green "Artifact Registry (both images live here)"
run gcloud artifacts repositories delete reachinbox --location="$REGION" --project="$PROJECT" --quiet

echo
green "Secret Manager"
for s in reachinbox-database-url reachinbox-redis-url reachinbox-jwt-secret; do
  run gcloud secrets delete "$s" --project="$PROJECT" --quiet
done

echo
green "Networking"
# Order matters: the firewall rule references the tag, and the subnet cannot be
# deleted while Cloud Run still holds addresses in it — hence services first.
run gcloud compute firewall-rules delete allow-cloudrun-to-datastores --project="$PROJECT" --quiet
run gcloud compute networks subnets delete subnet-cloudrun --region="$REGION" --project="$PROJECT" --quiet
run gcloud compute instances remove-tags "$VM" --zone="$ZONE" --project="$PROJECT" --tags=reachinbox-datastore

if [ "$REVERT_VM" = true ]; then
  echo
  yellow "Reverting VM datastore changes (destroys the production database)"
  run sudo -u postgres dropdb --if-exists reachinbox_prod
  run sudo -u postgres dropuser --if-exists reachinbox_prod
  if [ "$APPLY" = true ]; then
    echo "+ restoring Redis and Postgres listeners to loopback"
    sudo sed -i 's/^bind 127\.0\.0\.1 192\.168\.1\.2 -::1/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
    sudo sed -i '/^requirepass /d' /etc/redis/redis.conf
    sudo sed -i "s/^listen_addresses *=.*/listen_addresses = 'localhost'/" /etc/postgresql/17/main/postgresql.conf
    sudo sed -i '/192\.168\.16\.0\/26/d' /etc/postgresql/17/main/pg_hba.conf
    sudo systemctl restart redis-server postgresql
    yellow "Redis no longer requires a password — update REDIS_URL in your local .env."
  else
    echo "  would revert Redis bind/requirepass and Postgres listen_addresses/pg_hba"
  fi
else
  echo
  yellow "Left alone: the reachinbox_prod database, the Redis password, and the VM"
  yellow "listener config. Pass --revert-vm to undo those too."
fi

echo
green "Done."
[ "$APPLY" = true ] || yellow "That was a dry run."
