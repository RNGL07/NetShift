/**
 * POST /api/stripe/webhook — the authoritative source of subscription state.
 *
 * Two things here are load-bearing and easy to get subtly wrong:
 *
 * 1. **Raw body.** Stripe signs the exact bytes it sent. Vercel parses JSON
 *    bodies by default, and `JSON.stringify(req.body)` is *not* byte-identical
 *    to what was signed (key order, whitespace, unicode escaping), so
 *    verification against a re-serialised body fails intermittently — or,
 *    worse, someone "fixes" it by skipping verification. `config.api.bodyParser
 *    = false` below turns the parser off and the raw stream is read by hand.
 *
 * 2. **Idempotency.** Stripe retries on any non-2xx and can deliver the same
 *    event more than once. Every event is claimed by inserting its id into
 *    `stripe_events` first; a duplicate hits the primary key, and the handler
 *    returns 200 without doing the work twice.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import type Stripe from 'stripe';
import { requireEnv } from '../_lib/env';
import { logServerError } from '../_lib/http';
import { serviceClient } from '../_lib/supabase';
import { resolveUserId, stripeClient, syncSubscription } from '../_lib/stripe';

// Stripe signs the raw bytes; the body parser must be off for that to work.
export const config = { api: { bodyParser: false } };

/** The events NetShift acts on. Anything else is recorded and ignored. */
const HANDLED_EVENTS = new Set<string>([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

type ClaimOutcome = 'claimed' | 'duplicate' | 'in_progress';

/**
 * Claims an event for processing.
 *
 * Delegates to `claim_stripe_event`, which does the check and the claim in one
 * statement. It returns 'claimed' for a fresh event *and* for one whose
 * previous attempt failed, so Stripe's retry of a transient failure actually
 * gets to run — an insert-only guard would reject that retry as a duplicate
 * and leave a paying user without Pro.
 */
async function claimEvent(event: Stripe.Event): Promise<ClaimOutcome> {
  const { data, error } = await serviceClient().rpc('claim_stripe_event', {
    p_event_id: event.id,
    p_type: event.type,
    p_summary: { livemode: event.livemode, created: event.created },
  });
  if (error) throw error;
  return (data as ClaimOutcome) ?? 'in_progress';
}

async function markEvent(
  eventId: string,
  status: 'processed' | 'failed' | 'ignored',
  userId: string | null,
  errorMessage?: string,
): Promise<void> {
  const { error } = await serviceClient()
    .from('stripe_events')
    .update({
      status,
      user_id: userId,
      processed_at: new Date().toISOString(),
      error_message: errorMessage ?? null,
    })
    .eq('id', eventId);
  if (error) logServerError('stripe.webhook.mark', error, { eventId });
}

/** Loads the full subscription so every handler works from the same shape. */
async function fetchSubscription(id: string): Promise<Stripe.Subscription> {
  return stripeClient().subscriptions.retrieve(id);
}

async function handleEvent(event: Stripe.Event): Promise<string | null> {
  const stripe = stripeClient();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = await resolveUserId({
        metadataUserId: session.metadata?.supabase_user_id,
        clientReferenceId: session.client_reference_id,
        customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
      });
      if (!userId) return null;

      // A completed checkout does not by itself mean an active subscription —
      // the subscription object is what carries the real status, so read it.
      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id ?? null;
      if (!subscriptionId) return userId;

      const subscription = await fetchSubscription(subscriptionId);
      await syncSubscription(userId, subscription, event.id);
      return userId;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = await resolveUserId({
        metadataUserId: subscription.metadata?.supabase_user_id,
        customerId:
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id,
      });
      if (!userId) return null;

      // `deleted` arrives with status 'canceled' already set, so the same sync
      // path handles it — and `resolveEntitlement` keeps Pro alive to the end
      // of the period the user already paid for.
      await syncSubscription(userId, subscription, event.id);
      return userId;
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const userId = await resolveUserId({
        metadataUserId: invoice.metadata?.supabase_user_id,
        customerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id,
      });
      if (!userId) return null;

      const subscriptionId =
        typeof invoice.subscription === 'string'
          ? invoice.subscription
          : invoice.subscription?.id ?? null;
      if (!subscriptionId) return userId;

      // Re-read rather than inferring: a paid invoice may or may not have moved
      // the subscription out of past_due depending on what else is outstanding.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await syncSubscription(userId, subscription, event.id);
      return userId;
    }

    default:
      return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST only.' } });
    return;
  }

  const signature = req.headers['stripe-signature'];
  if (!signature || Array.isArray(signature)) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Missing signature.' } });
    return;
  }

  let event: Stripe.Event;
  try {
    const raw = await readRawBody(req);
    event = stripeClient().webhooks.constructEvent(
      raw,
      signature,
      requireEnv('STRIPE_WEBHOOK_SECRET'),
    );
  } catch (error) {
    // A signature failure is either a misconfiguration or an attack. Either
    // way the response says nothing about which.
    logServerError('stripe.webhook.verify', error);
    res.status(400).json({ error: { code: 'invalid_request', message: 'Invalid signature.' } });
    return;
  }

  if (!HANDLED_EVENTS.has(event.type)) {
    // 200 so Stripe stops retrying an event we will never act on.
    res.status(200).json({ received: true, handled: false });
    return;
  }

  let claim: ClaimOutcome;
  try {
    claim = await claimEvent(event);
  } catch (error) {
    // Could not even record the event: ask Stripe to retry rather than
    // risk processing it without the idempotency guard in place.
    logServerError('stripe.webhook.claim', error, { eventId: event.id, type: event.type });
    res.status(500).json({ error: { code: 'server_error', message: 'Try again.' } });
    return;
  }

  if (claim === 'duplicate') {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  if (claim === 'in_progress') {
    // Another delivery of this same event is mid-flight. A 409 tells Stripe to
    // retry later without us doing the work twice concurrently.
    res.status(409).json({ received: true, inProgress: true });
    return;
  }

  try {
    const userId = await handleEvent(event);
    await markEvent(event.id, userId ? 'processed' : 'ignored', userId);
    res.status(200).json({ received: true, handled: Boolean(userId) });
  } catch (error) {
    logServerError('stripe.webhook.handle', error, { eventId: event.id, type: event.type });
    await markEvent(
      event.id,
      'failed',
      null,
      error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    );
    // 500 makes Stripe retry, and the row is left in 'failed' so
    // `claim_stripe_event` lets that retry through.
    res.status(500).json({ error: { code: 'server_error', message: 'Processing failed.' } });
  }
}
