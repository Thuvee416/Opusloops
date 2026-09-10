#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
opus_test_container="opusloops-aws-db-test-$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"
cleanup() {
  docker stop --time 2 "$opus_test_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Synthetic data only. No host mounts, published ports, or external network.
docker run --rm --detach --name "$opus_test_container" --network none \
  --tmpfs /var/lib/postgresql/data \
  --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=opusloops_aws_test \
  postgres:17-alpine >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$opus_test_container" pg_isready -U postgres -d opusloops_aws_test >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 30 ]]; then echo 'Test database did not become ready' >&2; exit 1; fi
  sleep 1
done

# Apply as a non-superuser, approximating RDS migration privileges. This catches
# accidental dependencies on Supabase's superuser-only platform extensions.
docker exec "$opus_test_container" psql -X -v ON_ERROR_STOP=1 -U postgres -d opusloops_aws_test -c \
  'CREATE ROLE opusloops_migrator LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS; ALTER DATABASE opusloops_aws_test OWNER TO opusloops_migrator;' >/dev/null
node infra/aws-backend/database/compile.mjs | \
  docker exec -i "$opus_test_container" psql -X -q -v ON_ERROR_STOP=1 -U opusloops_migrator -d opusloops_aws_test >/dev/null

for test_file in supabase/tests/*.sql infra/aws-backend/database/identity-tests.sql; do
  printf 'Testing %s\n' "$test_file"
  docker exec -i "$opus_test_container" psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d opusloops_aws_test < "$test_file" | sed -n '/^ok /p'
done

# Validate the reversible source maintenance fence against synthetic tables.
docker exec -i "$opus_test_container" psql -X -q -v ON_ERROR_STOP=1 -U opusloops_migrator -d opusloops_aws_test < infra/aws-backend/database/freeze-source.sql >/dev/null
docker exec -i "$opus_test_container" psql -X -q -t -A -v ON_ERROR_STOP=1 -U opusloops_migrator -d opusloops_aws_test < infra/aws-backend/database/fence-tests.sql | sed -n '/^ok /p'

# Re-running bootstrap must fail, even if the database is otherwise reachable.
if node infra/aws-backend/database/compile.mjs | \
  docker exec -i "$opus_test_container" psql -X -q -v ON_ERROR_STOP=1 -U opusloops_migrator -d opusloops_aws_test >/dev/null 2>&1; then
  echo 'Bootstrap unexpectedly accepted an existing database' >&2
  exit 1
fi
echo 'Native PostgreSQL migration and isolation checks passed.'
