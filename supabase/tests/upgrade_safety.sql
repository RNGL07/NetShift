-- ---------------------------------------------------------------------------
-- Production upgrade safety.
--
-- Proves that applying the full migration set to a database that ALREADY holds
-- live 1.x data does not destroy or alter that data. This is the check that
-- has to pass before migrating a database real people are using.
--
-- Run by scripts/upgrade-test.sh, which seeds a 1.x-shaped database first.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

do $$
declare
  v_rows integer;
  v_value text;
begin
  -- 1. The 1.x key/value rows must still be present, byte for byte.
  select count(*) into v_rows from public.netshift_data;
  if v_rows <> 3 then
    raise exception 'legacy netshift_data rows lost: expected 3, found %', v_rows;
  end if;

  select value into v_value
    from public.netshift_data
   where key = 'paycheck-stubs';
  if v_value is null or v_value not like '%4391.44%' then
    raise exception 'legacy pay-stub payload was altered or lost';
  end if;
  raise notice 'legacy netshift_data preserved intact: OK (% rows)', v_rows;

  -- 2. The pre-existing auth user must survive.
  select count(*) into v_rows from auth.users;
  if v_rows <> 1 then
    raise exception 'existing auth user lost: expected 1, found %', v_rows;
  end if;
  raise notice 'existing auth user preserved: OK';

  -- 3. The new structured tables exist and are EMPTY — the migration must not
  --    silently transform legacy data. That is the user-confirmed import's job.
  select count(*) into v_rows from public.pay_stubs;
  if v_rows <> 0 then
    raise exception 'migration auto-created % pay_stubs rows; it must not transform legacy data silently', v_rows;
  end if;
  raise notice 'no silent transformation of legacy data: OK';

  -- 4. The backfill trigger must have created a profile and a free-tier
  --    subscription for the pre-existing user, or they cannot sign in.
  select count(*) into v_rows from public.profiles;
  if v_rows <> 1 then
    raise exception 'existing user has no profile row (found %) — they would be locked out', v_rows;
  end if;

  select count(*) into v_rows
    from public.subscriptions where entitlement = 'free';
  if v_rows <> 1 then
    raise exception 'existing user has no free-tier subscription row (found %)', v_rows;
  end if;
  raise notice 'pre-existing user has profile + free subscription: OK';

  -- 5. netshift_data must be read-only in 2.x: no INSERT/UPDATE policy.
  select count(*) into v_rows
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
   where c.relname = 'netshift_data'
     and p.polcmd in ('a', 'w');  -- 'a' = INSERT, 'w' = UPDATE
  if v_rows <> 0 then
    raise exception 'netshift_data still has % write policies; 2.x must not write to it', v_rows;
  end if;
  raise notice 'netshift_data is read-only in 2.x: OK';
end $$;

do $$ begin raise notice 'ALL UPGRADE SAFETY ASSERTIONS PASSED'; end $$;
