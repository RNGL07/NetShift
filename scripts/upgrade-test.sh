#!/usr/bin/env bash
#
# Simulates upgrading a LIVE NetShift 1.x database to the 2.x schema.
#
# The db-test.sh suite proves the migrations work on an empty database. That is
# not the question that matters before touching production. This one seeds a
# database that looks like the deployed 1.x app — an existing auth user and
# real rows in the netshift_data key/value table — then applies every migration
# and asserts that none of it was destroyed, altered, or silently transformed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="${PGBIN:-}:$PATH"

PGROOT="${PGROOT:-/var/tmp/netshift-upgradetest}"
PORT="${PGPORT_TEST:-5441}"
RUNAS=""
if [[ "$(id -u)" == "0" ]] && id -u postgres >/dev/null 2>&1; then RUNAS="postgres"; fi

cleanup() {
  if [[ -n "$RUNAS" ]]; then
    su "$RUNAS" -c "PATH=$PATH pg_ctl -D $PGROOT/pgdata stop -m immediate" >/dev/null 2>&1 || true
  else
    pg_ctl -D "$PGROOT/pgdata" stop -m immediate >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> Starting a throwaway PostgreSQL"
rm -rf "$PGROOT"; mkdir -p "$PGROOT/pgdata" "$PGROOT/pgsock"
if [[ -n "$RUNAS" ]]; then
  chown -R "$RUNAS" "$PGROOT"
  su "$RUNAS" -c "PATH=$PATH initdb -D $PGROOT/pgdata -A trust -U postgres" >"$PGROOT/initdb.log" 2>&1
  su "$RUNAS" -c "PATH=$PATH pg_ctl -D $PGROOT/pgdata -o '-k $PGROOT/pgsock -p $PORT -c listen_addresses=' -l $PGROOT/pg.log start -w" >/dev/null
else
  initdb -D "$PGROOT/pgdata" -A trust -U postgres >"$PGROOT/initdb.log" 2>&1
  pg_ctl -D "$PGROOT/pgdata" -o "-k $PGROOT/pgsock -p $PORT -c listen_addresses=" -l "$PGROOT/pg.log" start -w >/dev/null
fi

PSQL=(psql -h "$PGROOT/pgsock" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

echo "==> Building a database that looks like the deployed 1.x app"
"${PSQL[@]}" -f supabase/local/supabase_shim.sql

# The 1.x schema: one auth user and the generic key/value table, with data.
"${PSQL[@]}" <<'SEED'
insert into auth.users (id, email)
values ('99999999-9999-9999-9999-999999999999', 'existing-user@example.test');

create table public.netshift_data (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);
alter table public.netshift_data enable row level security;
-- A permissive 1.x-style policy, which 2.x must replace with read-only ones.
create policy "netshift_data: owner all" on public.netshift_data
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into public.netshift_data (user_id, key, value) values
  ('99999999-9999-9999-9999-999999999999', 'paycheck-stubs',
   '[{"pay_date":"03/06/2026","gross_pay":4391.44,"net_pay":3143.19,"hours_worked":92.5}]'),
  ('99999999-9999-9999-9999-999999999999', 'pay-ladder',
   '{"steps":[{"label":"1 Year","rate":40.61}],"currentStepId":null}'),
  ('99999999-9999-9999-9999-999999999999', 'invest-accounts',
   '[{"id":1,"name":"401k","kind":"holdings","holdings":[{"ticker":"VOO","shares":"10"}]}]');
SEED

BEFORE=$("${PSQL[@]}" -tAc "select md5(string_agg(key || coalesce(value,''), '|' order by key)) from public.netshift_data;")
echo "    seeded. legacy data fingerprint: ${BEFORE:0:16}..."

echo "==> Applying every migration to the live-looking database"
for file in supabase/migrations/*.sql; do
  echo "    $(basename "$file")"
  "${PSQL[@]}" -f "$file" 2>&1 | grep -v '^psql:.*NOTICE' || true
done

echo "==> Applying them a second time (a re-run must also be safe)"
for file in supabase/migrations/*.sql; do
  "${PSQL[@]}" -f "$file" >/dev/null 2>&1
done

AFTER=$("${PSQL[@]}" -tAc "select md5(string_agg(key || coalesce(value,''), '|' order by key)) from public.netshift_data;")
echo "    legacy data fingerprint after:  ${AFTER:0:16}..."

if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "FAIL: legacy user data changed during migration." >&2
  exit 1
fi
echo "    byte-for-byte identical."

echo "==> Running upgrade safety assertions"
out=$("${PSQL[@]}" -f supabase/tests/upgrade_safety.sql 2>&1 || true)
echo "$out" | sed 's/^psql:[^ ]*: NOTICE:  /    /'
if ! echo "$out" | grep -q 'ALL UPGRADE SAFETY ASSERTIONS PASSED'; then
  echo "Upgrade safety assertions did not complete." >&2
  exit 1
fi

echo
echo "Upgrade is safe: existing user data survives the migration unchanged."
