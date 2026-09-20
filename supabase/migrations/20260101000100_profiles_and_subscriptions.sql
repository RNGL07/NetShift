-- ---------------------------------------------------------------------------
-- 0001 — User profiles, subscriptions, entitlements, and AI usage.
--
-- Trust boundary: every table here is readable by its owner and writable only
-- by the service role, except `profiles`, which the owner may update. A user
-- must never be able to write their own entitlement row — that would be a
-- one-line path to free Pro — so the subscription tables carry read-only
-- policies for `authenticated` and no INSERT/UPDATE/DELETE policy at all.
-- The service role bypasses RLS, which is how the Stripe webhook writes them.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  -- Free-text, shown nowhere public; used to tailor example wage profiles.
  employer_name text,
  facility text,
  job_classification text,
  timezone text not null default 'America/Chicago',
  onboarding_completed_at timestamptz,
  -- Set when the user has imported (or declined to import) legacy
  -- netshift_data rows, so the prompt is only shown once.
  legacy_import_status text not null default 'pending'
    check (legacy_import_status in ('pending', 'imported', 'skipped', 'none_found')),
  legacy_imported_at timestamptz,
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. Created automatically by the handle_new_user trigger.';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

drop policy if exists "profiles: owner can read" on public.profiles;
create policy "profiles: owner can read"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles: owner can update" on public.profiles;
create policy "profiles: owner can update"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Insert is handled by the trigger below (which runs as definer), but an
-- explicit policy lets the app self-heal if a row is ever missing.
drop policy if exists "profiles: owner can insert own row" on public.profiles;
create policy "profiles: owner can insert own row"
  on public.profiles for insert
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- subscriptions
--
-- One row per user, created free at sign-up and then owned by the Stripe
-- webhook. Stripe is authoritative: nothing in this table is ever written
-- from a Checkout success redirect.
-- ---------------------------------------------------------------------------

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_price_id text,
  status public.subscription_status not null default 'none',
  -- Derived from status + period end by the application's resolveEntitlement.
  entitlement public.plan_tier not null default 'free',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  trial_end timestamptz,
  -- When the subscription first entered past_due, for the grace-period clock.
  past_due_since timestamptz,
  -- The most recent Stripe event applied to this row, for debugging.
  last_stripe_event_id text,
  last_stripe_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subscriptions is
  'Stripe subscription state mirrored per user. Written only by the service role.';
comment on column public.subscriptions.entitlement is
  'The tier the server grants. Derived from Stripe state, never set by the client.';

create index if not exists subscriptions_stripe_customer_idx
  on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_status_idx
  on public.subscriptions (status);

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

-- Read-only for the owner. Deliberately no write policy: the service role
-- bypasses RLS and is the only thing that may change entitlement.
drop policy if exists "subscriptions: owner can read" on public.subscriptions;
create policy "subscriptions: owner can read"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- stripe_events — webhook idempotency
--
-- Stripe retries deliveries and can deliver the same event more than once.
-- The primary key on the event id is what makes processing idempotent: the
-- handler inserts first and treats a unique violation as "already handled".
-- ---------------------------------------------------------------------------

create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  -- The user the event resolved to, when it could be resolved.
  user_id uuid references auth.users (id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'processing'
    check (status in ('processing', 'processed', 'failed', 'ignored')),
  error_message text,
  -- Kept small on purpose: enough to debug, never the full payload.
  summary jsonb not null default '{}'::jsonb
);

comment on table public.stripe_events is
  'Processed Stripe event ids. The primary key provides webhook idempotency.';

create index if not exists stripe_events_user_idx on public.stripe_events (user_id);
create index if not exists stripe_events_received_idx on public.stripe_events (received_at desc);

alter table public.stripe_events enable row level security;
-- No policies: this table is service-role only. Users never read it.

-- ---------------------------------------------------------------------------
-- ai_usage_events — one row per AI call
--
-- Records that a call happened and what it cost in allowance terms. It
-- deliberately stores no document content and no extracted financial values.
-- ---------------------------------------------------------------------------

create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  operation public.ai_operation not null,
  -- The YYYY-MM the call counts against, so a monthly allowance is a lookup
  -- rather than a scan over a date range.
  usage_month text not null,
  counts_toward_allowance boolean not null default true,
  tier_at_time public.plan_tier not null default 'free',
  model text,
  input_tokens integer,
  output_tokens integer,
  -- 'ok' | 'error'. Errors are recorded but do not consume allowance.
  outcome text not null default 'ok' check (outcome in ('ok', 'error')),
  -- A short, non-sensitive error category. Never a raw provider message.
  error_code text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  constraint ai_usage_events_month_format check (usage_month ~ '^\d{4}-\d{2}$')
);

comment on table public.ai_usage_events is
  'Audit trail of AI calls. Stores no document content and no extracted financial fields.';

create index if not exists ai_usage_events_allowance_idx
  on public.ai_usage_events (user_id, usage_month, operation)
  where counts_toward_allowance and outcome = 'ok';

create index if not exists ai_usage_events_user_created_idx
  on public.ai_usage_events (user_id, created_at desc);

alter table public.ai_usage_events enable row level security;

drop policy if exists "ai_usage_events: owner can read" on public.ai_usage_events;
create policy "ai_usage_events: owner can read"
  on public.ai_usage_events for select
  using (auth.uid() = user_id);
-- Writes are service-role only, so a client cannot avoid consuming allowance
-- by declining to record its own usage.

-- ---------------------------------------------------------------------------
-- ai_usage_counters — the fast path for a limit check
--
-- A counter row per (user, month, operation). The AI endpoints increment it
-- atomically before calling the provider, which closes the race where two
-- concurrent uploads both read "4 of 5 used" and both proceed.
-- ---------------------------------------------------------------------------

create table if not exists public.ai_usage_counters (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_month text not null,
  operation public.ai_operation not null,
  used integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_month, operation),
  constraint ai_usage_counters_month_format check (usage_month ~ '^\d{4}-\d{2}$')
);

comment on table public.ai_usage_counters is
  'Atomic per-month AI allowance counters. Incremented by the service role only.';

alter table public.ai_usage_counters enable row level security;

drop policy if exists "ai_usage_counters: owner can read" on public.ai_usage_counters;
create policy "ai_usage_counters: owner can read"
  on public.ai_usage_counters for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Atomic allowance claim
--
-- Returns the new count if the claim succeeded, or null when the limit is
-- already reached. Doing this in one statement is what makes it race-free.
-- `p_limit < 0` means unlimited.
-- ---------------------------------------------------------------------------

create or replace function public.claim_ai_usage(
  p_user_id uuid,
  p_month text,
  p_operation public.ai_operation,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  insert into public.ai_usage_counters (user_id, usage_month, operation, used)
  values (p_user_id, p_month, p_operation, 1)
  on conflict (user_id, usage_month, operation) do update
    set used = public.ai_usage_counters.used + 1,
        updated_at = now()
    where p_limit < 0 or public.ai_usage_counters.used < p_limit
  returning used into v_used;

  -- No row came back: the ON CONFLICT predicate failed, i.e. the limit is spent.
  return v_used;
end;
$$;

comment on function public.claim_ai_usage is
  'Atomically consumes one unit of a monthly AI allowance. Returns null when the limit is reached.';

revoke all on function public.claim_ai_usage(uuid, text, public.ai_operation, integer) from public;
revoke all on function public.claim_ai_usage(uuid, text, public.ai_operation, integer) from anon;
revoke all on function public.claim_ai_usage(uuid, text, public.ai_operation, integer) from authenticated;

-- Releases a claim when the provider call fails, so a 500 does not silently
-- cost the user a parse.
create or replace function public.release_ai_usage(
  p_user_id uuid,
  p_month text,
  p_operation public.ai_operation
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ai_usage_counters
     set used = greatest(0, used - 1),
         updated_at = now()
   where user_id = p_user_id
     and usage_month = p_month
     and operation = p_operation;
end;
$$;

revoke all on function public.release_ai_usage(uuid, text, public.ai_operation) from public;
revoke all on function public.release_ai_usage(uuid, text, public.ai_operation) from anon;
revoke all on function public.release_ai_usage(uuid, text, public.ai_operation) from authenticated;

-- ---------------------------------------------------------------------------
-- Automatic profile creation
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  insert into public.subscriptions (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user is
  'Creates the profile and the (free-tier) subscription row for a new auth user.';

-- The trigger lives on auth.users, so a user created by any Supabase auth
-- flow (email, magic link, OAuth) lands with a profile and a free-tier
-- subscription row already in place.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
