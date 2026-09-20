#!/usr/bin/env bash
#
# Applies every migration, the seed, and the row-level-security assertions to a
# throwaway PostgreSQL instance, then throws it away.
#
# This exists because RLS is the only thing standing between one user's pay
# stubs and another's. "The policies look right" is not a check; running two
# real sessions against the real policies is.
#
# Usage:
#   scripts/db-test.sh                 # spin up a local throwaway Postgres
#   DATABASE_URL=postgres://... scripts/db-test.sh   # use an existing database
#
# Against a real Supabase project the auth/storage schemas already exist, so
# the local shim is skipped.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q)
  USE_SHIM="${USE_SHIM:-0}"
  echo "==> Using DATABASE_URL"
else
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -z "$PGBIN" ]] && ! command -v initdb >/dev/null 2>&1; then
    echo "No PostgreSQL found. Install postgresql, or set DATABASE_URL." >&2
    exit 1
  fi
  export PATH="${PGBIN:-}:$PATH"

  PGROOT="${PGROOT:-/var/tmp/netshift-dbtest}"
  PORT="${PGPORT_TEST:-5439}"
  RUNAS="${PGRUNAS:-}"
  if [[ -z "$RUNAS" ]] && [[ "$(id -u)" == "0" ]] && id -u postgres >/dev/null 2>&1; then
    RUNAS="postgres"
  fi

  cleanup() {
    if [[ -n "$RUNAS" ]]; then
      su "$RUNAS" -c "PATH=$PATH pg_ctl -D $PGROOT/pgdata stop -m immediate" >/dev/null 2>&1 || true
    else
      pg_ctl -D "$PGROOT/pgdata" stop -m immediate >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT

  echo "==> Starting a throwaway PostgreSQL in $PGROOT"
  rm -rf "$PGROOT"
  mkdir -p "$PGROOT/pgdata" "$PGROOT/pgsock"
  if [[ -n "$RUNAS" ]]; then
    chown -R "$RUNAS" "$PGROOT"
    su "$RUNAS" -c "PATH=$PATH initdb -D $PGROOT/pgdata -A trust -U postgres" >"$PGROOT/initdb.log" 2>&1
    su "$RUNAS" -c "PATH=$PATH pg_ctl -D $PGROOT/pgdata -o '-k $PGROOT/pgsock -p $PORT -c listen_addresses=' -l $PGROOT/pg.log start -w" >/dev/null
  else
    initdb -D "$PGROOT/pgdata" -A trust -U postgres >"$PGROOT/initdb.log" 2>&1
    pg_ctl -D "$PGROOT/pgdata" -o "-k $PGROOT/pgsock -p $PORT -c listen_addresses=" -l "$PGROOT/pg.log" start -w >/dev/null
  fi

  PSQL=(psql -h "$PGROOT/pgsock" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
  USE_SHIM=1
fi

if [[ "${USE_SHIM:-0}" == "1" ]]; then
  echo "==> Applying the local Supabase shim (auth + storage stand-ins)"
  "${PSQL[@]}" -f supabase/local/supabase_shim.sql
fi

echo "==> Applying migrations"
for file in supabase/migrations/*.sql; do
  echo "    $(basename "$file")"
  "${PSQL[@]}" -f "$file" 2>&1 | grep -v '^psql:.*NOTICE' || true
done

echo "==> Applying seed"
"${PSQL[@]}" -f supabase/seed.sql

echo "==> Re-applying migrations and seed (idempotency check)"
for file in supabase/migrations/*.sql; do
  "${PSQL[@]}" -f "$file" >/dev/null 2>&1
done
"${PSQL[@]}" -f supabase/seed.sql >/dev/null

echo "==> Running row-level-security assertions"
psql_out=$("${PSQL[@]}" -f supabase/tests/rls.sql 2>&1)
echo "$psql_out" | sed 's/^psql:[^ ]*: NOTICE:  /    /'
if ! echo "$psql_out" | grep -q 'ALL RLS ASSERTIONS PASSED'; then
  echo "RLS assertions did not complete." >&2
  exit 1
fi

echo "==> Verifying every user-owned table has RLS enabled"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -f supabase/tests/rls_coverage.sql

echo
echo "Database checks passed."
