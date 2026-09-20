-- ---------------------------------------------------------------------------
-- Row-level security regression test.
--
-- Creates two users, gives each some data, and then asserts from inside each
-- user's session that the other's rows are invisible and unwritable. Run with
-- `npm run db:test` (see README) against a database that has the migrations
-- applied.
--
-- It uses `set local role authenticated` plus a JWT sub claim, which is exactly
-- how PostgREST presents a signed-in user, so the policies are exercised the
-- same way production exercises them.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
begin;

-- --- Fixtures --------------------------------------------------------------

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test')
on conflict (id) do nothing;

-- The handle_new_user trigger has already created profiles and subscriptions.

insert into public.user_pay_profiles (id, user_id, name, base_rate)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Alice profile', 40.61),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Bob profile', 32.47);

insert into public.pay_stubs (id, user_id, pay_date, gross_pay, net_pay)
values
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '2026-03-06', 4391.44, 3143.19),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', '2026-03-06', 2800.00, 2100.00);

insert into public.goals (id, user_id, name, target_amount)
values
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Alice emergency fund', 10000),
  ('bbbbbbbb-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'Bob truck', 5000);

insert into public.debts (id, user_id, name, balance, apr, minimum_payment)
values
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Alice card', 5000, 24, 150),
  ('bbbbbbbb-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'Bob card', 2000, 19, 80);

insert into public.netshift_data (user_id, key, value)
values ('11111111-1111-1111-1111-111111111111', 'paycheck-stubs', '[{"gross_pay":100}]');

-- --- Assertions as Alice ---------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare n integer;
begin
  select count(*) into n from public.user_pay_profiles;
  if n <> 1 then raise exception 'alice sees % pay profiles, expected 1', n; end if;

  select count(*) into n from public.pay_stubs;
  if n <> 1 then raise exception 'alice sees % pay stubs, expected 1', n; end if;

  select count(*) into n from public.goals;
  if n <> 1 then raise exception 'alice sees % goals, expected 1', n; end if;

  select count(*) into n from public.debts;
  if n <> 1 then raise exception 'alice sees % debts, expected 1', n; end if;

  select count(*) into n from public.netshift_data;
  if n <> 1 then raise exception 'alice sees % legacy rows, expected 1', n; end if;

  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'alice sees % profiles, expected 1', n; end if;

  select count(*) into n from public.subscriptions;
  if n <> 1 then raise exception 'alice sees % subscriptions, expected 1', n; end if;

  -- Bob's rows specifically must be invisible, not merely filtered by chance.
  select count(*) into n from public.pay_stubs
   where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'alice can read bob''s pay stub'; end if;

  raise notice 'alice read isolation: OK';
end $$;

-- Alice must not be able to update Bob's rows (the UPDATE simply matches none).
do $$
declare n integer;
begin
  update public.goals set target_amount = 1
   where id = 'bbbbbbbb-0000-0000-0000-000000000003';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'alice updated bob''s goal'; end if;

  delete from public.debts where id = 'bbbbbbbb-0000-0000-0000-000000000004';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'alice deleted bob''s debt'; end if;

  raise notice 'alice write isolation: OK';
end $$;

-- Alice must not be able to create a row attributed to Bob.
do $$
begin
  begin
    insert into public.goals (user_id, name, target_amount)
    values ('22222222-2222-2222-2222-222222222222', 'Injected', 1);
    raise exception 'alice inserted a goal owned by bob';
  exception
    when insufficient_privilege then
      raise notice 'alice cross-user insert blocked: OK';
  end;
end $$;

-- Alice must not be able to grant herself Pro.
do $$
declare n integer;
begin
  begin
    update public.subscriptions set entitlement = 'pro', status = 'active'
     where user_id = '11111111-1111-1111-1111-111111111111';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'alice granted herself pro entitlement'; end if;
  exception
    when insufficient_privilege then
      n := 0; -- no UPDATE policy at all is the expected outcome
  end;
  raise notice 'entitlement self-grant blocked: OK';
end $$;

-- Alice must not be able to write her own AI usage counters.
do $$
declare n integer;
begin
  begin
    update public.ai_usage_counters set used = 0
     where user_id = '11111111-1111-1111-1111-111111111111';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'alice reset her own AI usage counter'; end if;
  exception
    when insufficient_privilege then
      n := 0;
  end;
  raise notice 'AI usage counter self-reset blocked: OK';
end $$;

-- Alice must not be able to read the Stripe event log.
do $$
declare n integer;
begin
  begin
    select count(*) into n from public.stripe_events;
    if n <> 0 then raise exception 'alice read % stripe events', n; end if;
  exception
    when insufficient_privilege then
      n := 0;
  end;
  raise notice 'stripe event log hidden: OK';
end $$;

-- Shared reference data must remain readable.
do $$
declare n integer;
begin
  select count(*) into n from public.wage_profile_versions;
  if n < 1 then raise exception 'alice cannot read shared wage profiles'; end if;
  raise notice 'shared wage profiles readable: OK';
end $$;

-- --- Assertions as Bob -----------------------------------------------------

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare n integer;
begin
  select count(*) into n from public.pay_stubs;
  if n <> 1 then raise exception 'bob sees % pay stubs, expected 1', n; end if;

  select count(*) into n from public.netshift_data;
  if n <> 0 then raise exception 'bob sees % legacy rows, expected 0', n; end if;

  select count(*) into n from public.user_pay_profiles
   where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'bob can read alice''s pay profile'; end if;

  raise notice 'bob isolation: OK';
end $$;

-- --- Anonymous callers see nothing ----------------------------------------
--
-- `anon` holds no table grant at all (migration 0010), so the expected outcome
-- is a privilege error rather than an empty result. Either is a pass; what
-- must never happen is a row coming back.

set local role anon;
set local request.jwt.claim.sub = '';

do $$
declare n integer;
begin
  begin
    select count(*) into n from public.pay_stubs;
    if n <> 0 then raise exception 'anonymous caller sees % pay stubs', n; end if;
  exception
    when insufficient_privilege then
      null; -- no grant: the stronger outcome
  end;

  begin
    select count(*) into n from public.wage_profile_versions;
    if n <> 0 then raise exception 'anonymous caller sees % wage profiles', n; end if;
  exception
    when insufficient_privilege then
      null;
  end;

  raise notice 'anonymous isolation: OK';
end $$;

reset role;

do $$ begin raise notice 'ALL RLS ASSERTIONS PASSED'; end $$;

rollback;
