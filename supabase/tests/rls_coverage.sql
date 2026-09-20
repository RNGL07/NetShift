-- ---------------------------------------------------------------------------
-- Coverage assertion: every table in `public` must have row-level security
-- enabled, and every user-owned table must carry at least one policy.
--
-- A table added in a later migration without RLS would be silently readable by
-- every signed-in user. This turns that mistake into a failing check rather
-- than a breach.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

do $$
declare
  missing text[];
begin
  select array_agg(c.relname order by c.relname)
    into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if missing is not null then
    raise exception 'tables in public without RLS enabled: %', array_to_string(missing, ', ');
  end if;

  raise notice 'RLS enabled on every public table: OK';
end $$;

do $$
declare
  owned text[];
begin
  -- Any table with a user_id column is user-owned and must have a policy.
  select array_agg(distinct c.relname order by c.relname)
    into owned
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and a.attnum > 0
  where n.nspname = 'public'
    and c.relkind = 'r'
    -- Deliberately policy-free: service-role only. A user must not be able to
    -- read the Stripe event log or reset their own rate-limit bucket, so these
    -- carry no policy and no grant at all rather than a restrictive one.
    and c.relname not in ('stripe_events', 'rate_limit_buckets')
    and not exists (
      select 1 from pg_policy p where p.polrelid = c.oid
    );

  if owned is not null then
    raise exception 'user-owned tables without any policy: %', array_to_string(owned, ', ');
  end if;

  raise notice 'every user-owned table has a policy: OK';
end $$;

-- `anon` must hold no privilege on any table carrying user data.
do $$
declare
  leaked text[];
begin
  select array_agg(distinct c.relname order by c.relname)
    into leaked
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and a.attnum > 0
  where n.nspname = 'public'
    and c.relkind = 'r'
    and (
      has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('anon', c.oid, 'INSERT')
      or has_table_privilege('anon', c.oid, 'UPDATE')
      or has_table_privilege('anon', c.oid, 'DELETE')
    );

  if leaked is not null then
    raise exception 'anon holds privileges on user-owned tables: %', array_to_string(leaked, ', ');
  end if;

  raise notice 'anon holds no privilege on user-owned tables: OK';
end $$;

-- The entitlement column must not be writable by a signed-in user.
do $$
begin
  if has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.subscriptions', 'INSERT') then
    raise exception 'authenticated can write public.subscriptions — entitlement is self-grantable';
  end if;
  raise notice 'subscriptions not writable by authenticated: OK';
end $$;

do $$ begin raise notice 'ALL COVERAGE ASSERTIONS PASSED'; end $$;
