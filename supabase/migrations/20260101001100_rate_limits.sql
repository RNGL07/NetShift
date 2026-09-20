-- ---------------------------------------------------------------------------
-- 0011 — Durable rate-limit buckets.
--
-- Serverless functions share no memory, so an in-process counter limits
-- nothing: each cold start begins at zero and each concurrent instance keeps
-- its own tally. This is the smallest durable counter that actually works —
-- one row per (user, bucket, fixed window), incremented atomically.
--
-- Rows are disposable. A daily cleanup is provided but is not required for
-- correctness: an old window is simply never read again.
-- ---------------------------------------------------------------------------

create table if not exists public.rate_limit_buckets (
  user_id uuid not null references auth.users (id) on delete cascade,
  bucket text not null,
  -- The start of the fixed window this count belongs to.
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, bucket, window_start)
);

comment on table public.rate_limit_buckets is
  'Fixed-window request counters. Service-role only; a user must not be able to reset their own.';

create index if not exists rate_limit_buckets_window_idx
  on public.rate_limit_buckets (window_start);

alter table public.rate_limit_buckets enable row level security;
-- No policies: service-role only. A user resetting their own limiter would
-- defeat the point of having one.

-- ---------------------------------------------------------------------------
-- Atomic consume
--
-- Returns the new count, or null when the window's limit is already spent.
-- The `where` on the ON CONFLICT clause is what makes this a single-statement
-- check-and-increment rather than a read followed by a racy write.
-- ---------------------------------------------------------------------------

create or replace function public.consume_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_window_start timestamptz,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.rate_limit_buckets (user_id, bucket, window_start, count)
  values (p_user_id, p_bucket, p_window_start, 1)
  on conflict (user_id, bucket, window_start) do update
    set count = public.rate_limit_buckets.count + 1,
        updated_at = now()
    where public.rate_limit_buckets.count < p_limit
  returning count into v_count;

  return v_count;
end;
$$;

comment on function public.consume_rate_limit is
  'Atomically consumes one token from a fixed-window bucket. Returns null when the window is spent.';

revoke all on function public.consume_rate_limit(uuid, text, timestamptz, integer) from public;
revoke all on function public.consume_rate_limit(uuid, text, timestamptz, integer) from anon;
revoke all on function public.consume_rate_limit(uuid, text, timestamptz, integer) from authenticated;

-- Housekeeping for anyone who wants to schedule it; not required for correctness.
create or replace function public.prune_rate_limit_buckets(p_older_than interval default interval '1 day')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed integer;
begin
  delete from public.rate_limit_buckets where window_start < now() - p_older_than;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

revoke all on function public.prune_rate_limit_buckets(interval) from public;
revoke all on function public.prune_rate_limit_buckets(interval) from anon;
revoke all on function public.prune_rate_limit_buckets(interval) from authenticated;
