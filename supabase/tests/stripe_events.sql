-- ---------------------------------------------------------------------------
-- Webhook idempotency assertions.
--
-- The claim function is the only thing standing between a Stripe retry storm
-- and a subscription being synced several times, and between a transient
-- failure and a paying user silently never getting Pro. Both paths are
-- asserted here rather than reasoned about.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
begin;

do $$
declare r text;
begin
  -- A fresh event is claimed.
  r := public.claim_stripe_event('evt_test_1', 'customer.subscription.updated');
  if r <> 'claimed' then raise exception 'fresh event returned %, expected claimed', r; end if;

  -- A second delivery while the first is still processing must not run again.
  r := public.claim_stripe_event('evt_test_1', 'customer.subscription.updated');
  if r <> 'in_progress' then raise exception 'concurrent delivery returned %, expected in_progress', r; end if;

  -- Once processed, further deliveries are duplicates for good.
  update public.stripe_events set status = 'processed', processed_at = now()
   where id = 'evt_test_1';
  r := public.claim_stripe_event('evt_test_1', 'customer.subscription.updated');
  if r <> 'duplicate' then raise exception 'processed event returned %, expected duplicate', r; end if;

  raise notice 'duplicate suppression: OK';
end $$;

do $$
declare r text;
begin
  -- A failed attempt must be retryable, or a transient error would leave a
  -- paying user without Pro and no further delivery would ever fix it.
  r := public.claim_stripe_event('evt_test_2', 'invoice.paid');
  if r <> 'claimed' then raise exception 'fresh event returned %', r; end if;

  update public.stripe_events set status = 'failed', error_message = 'boom'
   where id = 'evt_test_2';

  r := public.claim_stripe_event('evt_test_2', 'invoice.paid');
  if r <> 'claimed' then raise exception 'failed event returned %, expected claimed', r; end if;

  -- Re-claiming must clear the previous error.
  if exists (select 1 from public.stripe_events where id = 'evt_test_2' and error_message is not null) then
    raise exception 're-claim did not clear the previous error';
  end if;

  raise notice 'failed-event retry: OK';
end $$;

do $$
declare r text;
begin
  -- A claim abandoned by a killed function must not wedge the event forever.
  r := public.claim_stripe_event('evt_test_3', 'checkout.session.completed');
  if r <> 'claimed' then raise exception 'fresh event returned %', r; end if;

  update public.stripe_events set received_at = now() - interval '30 minutes'
   where id = 'evt_test_3';

  r := public.claim_stripe_event('evt_test_3', 'checkout.session.completed');
  if r <> 'claimed' then raise exception 'stale claim returned %, expected claimed', r; end if;

  -- But a *recent* claim is still respected.
  r := public.claim_stripe_event('evt_test_3', 'checkout.session.completed');
  if r <> 'in_progress' then raise exception 'recent claim returned %, expected in_progress', r; end if;

  raise notice 'stale-claim takeover: OK';
end $$;

do $$
declare n integer;
begin
  -- An ignored event is terminal too: NetShift will never act on it, so a
  -- retry must not reopen it.
  perform public.claim_stripe_event('evt_test_4', 'customer.created');
  update public.stripe_events set status = 'ignored' where id = 'evt_test_4';
  if public.claim_stripe_event('evt_test_4', 'customer.created') <> 'duplicate' then
    raise exception 'ignored event was re-claimed';
  end if;

  select count(*) into n from public.stripe_events;
  if n <> 4 then raise exception 'expected 4 event rows, found %', n; end if;

  raise notice 'ignored events terminal: OK';
end $$;

do $$ begin raise notice 'ALL WEBHOOK ASSERTIONS PASSED'; end $$;

rollback;
