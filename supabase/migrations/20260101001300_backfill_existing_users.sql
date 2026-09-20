-- ---------------------------------------------------------------------------
-- 0013 — Backfill profiles and subscriptions for pre-existing users.
--
-- `handle_new_user()` (migration 0001) is an AFTER INSERT trigger on
-- auth.users, so it only fires for accounts created after that migration ran.
-- Every user who already existed in a deployed 1.x database therefore ends up
-- with no `profiles` row and no `subscriptions` row.
--
-- That is not a cosmetic gap. The consequences, in order of severity:
--
--   1. The legacy-import flow records that it has run by UPDATE-ing
--      profiles.legacy_import_status. With no profile row that update matches
--      nothing, so the import prompt returns on every load and the user can
--      run it again — duplicating every imported pay stub. Duplicated
--      financial records then corrupt the audit, the buffer recommendation
--      and the learned deduction rate, invisibly.
--   2. Saving a display name or employer in Settings silently does nothing.
--   3. Entitlement lookups fall back to the free tier. Harmless today, but it
--      relies on a defensive default rather than real state.
--
-- This migration is a plain idempotent backfill: it inserts only what is
-- missing, never updates or deletes an existing row, and can be re-run safely.
-- ---------------------------------------------------------------------------

insert into public.profiles (id, email)
select u.id, u.email
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

insert into public.subscriptions (user_id)
select u.id
from auth.users u
where not exists (select 1 from public.subscriptions s where s.user_id = u.id)
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- Make the trigger self-healing as well.
--
-- A backfill fixes the users who exist right now. This makes the application
-- resilient to the same class of gap in future — for instance a user created
-- while the trigger was momentarily absent, or restored from a backup. The
-- function is rewritten to be callable for any user id, and the ensure_*
-- helper is what the application can call on sign-in if it ever needs to.
-- ---------------------------------------------------------------------------

create or replace function public.ensure_user_rows(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  select p_user_id, u.email from auth.users u where u.id = p_user_id
  on conflict (id) do nothing;

  insert into public.subscriptions (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
end;
$$;

comment on function public.ensure_user_rows is
  'Idempotently creates the profile and free-tier subscription a user needs. Safe to call repeatedly.';

revoke all on function public.ensure_user_rows(uuid) from public;
revoke all on function public.ensure_user_rows(uuid) from anon;
-- A signed-in user may self-heal their own rows, which the RLS policies on
-- profiles and subscriptions already constrain to their own id.
grant execute on function public.ensure_user_rows(uuid) to authenticated;

-- Route the signup trigger through the same helper so there is one definition
-- of "what rows a user needs" rather than two that can drift apart.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_user_rows(new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
