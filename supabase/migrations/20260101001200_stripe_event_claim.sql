-- ---------------------------------------------------------------------------
-- 0012 — Atomic, retry-aware Stripe event claiming.
--
-- The webhook's idempotency comes from inserting the event id before doing the
-- work. A plain insert is not quite enough, though: if processing then fails
-- transiently (a database blip, a Stripe read timing out), the row is already
-- there, so Stripe's retry is rejected as a duplicate and the subscription
-- never syncs. The user has paid and has no Pro, and nothing looks broken.
--
-- This function makes the claim atomic *and* retryable:
--   - no row            → claim it, return 'claimed'
--   - row 'failed'      → re-claim it, return 'claimed' (Stripe's retry works)
--   - row 'processing'  → another delivery is mid-flight, return 'in_progress'
--   - row 'processed'   → genuine duplicate, return 'duplicate'
--
-- The 'processing' case also has a stale-claim escape: a function that is
-- killed mid-run (a timeout) would otherwise leave the event wedged forever,
-- so a claim older than the reclaim window is taken over.
-- ---------------------------------------------------------------------------

create or replace function public.claim_stripe_event(
  p_event_id text,
  p_type text,
  p_summary jsonb default '{}'::jsonb,
  p_reclaim_after interval default interval '5 minutes'
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_received timestamptz;
begin
  insert into public.stripe_events (id, type, status, summary)
  values (p_event_id, p_type, 'processing', coalesce(p_summary, '{}'::jsonb))
  on conflict (id) do nothing;

  if found then
    return 'claimed';
  end if;

  select status, received_at into v_status, v_received
  from public.stripe_events
  where id = p_event_id
  for update;

  if v_status = 'processed' or v_status = 'ignored' then
    return 'duplicate';
  end if;

  if v_status = 'failed'
     or (v_status = 'processing' and v_received < now() - p_reclaim_after) then
    update public.stripe_events
       set status = 'processing',
           received_at = now(),
           processed_at = null,
           error_message = null
     where id = p_event_id;
    return 'claimed';
  end if;

  return 'in_progress';
end;
$$;

comment on function public.claim_stripe_event is
  'Atomically claims a Stripe event for processing. Failed and stale claims are retryable; processed ones are not.';

revoke all on function public.claim_stripe_event(text, text, jsonb, interval) from public;
revoke all on function public.claim_stripe_event(text, text, jsonb, interval) from anon;
revoke all on function public.claim_stripe_event(text, text, jsonb, interval) from authenticated;
