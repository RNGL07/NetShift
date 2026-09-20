/**
 * Stripe client and subscription synchronisation.
 *
 * The rule this module exists to enforce: **Stripe webhook state is
 * authoritative**. Nothing else writes `subscriptions`. In particular the
 * Checkout success redirect never grants Pro — a user can navigate to the
 * success URL directly, so treating that redirect as proof of payment would
 * hand out free subscriptions to anyone who read the URL bar.
 */

import Stripe from 'stripe';
import { requireEnv, readEnv } from './env';
import { logServerError } from './http';
import { serviceClient } from './supabase';
import { resolveEntitlement, type SubscriptionStatus } from '../../src/config/plans';

let cachedStripe: Stripe | null = null;

export function stripeClient(): Stripe {
  if (cachedStripe) return cachedStripe;
  cachedStripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
    // Pinned so a Stripe-side API upgrade cannot silently change the shape of
    // the objects the webhook reads.
    apiVersion: '2024-06-20',
    typescript: true,
    appInfo: { name: 'NetShift', version: '2.0.0' },
  });
  return cachedStripe;
}

/** The recurring price to sell. The *amount* lives in Stripe, never in code. */
export function proPriceId(): string {
  return requireEnv('STRIPE_PRO_PRICE_ID');
}

/** Number of trial days to offer, or null for none. Configured in the environment. */
export function trialDays(): number | null {
  const raw = readEnv('STRIPE_TRIAL_DAYS');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * Maps a Stripe status string onto our enum.
 *
 * Unrecognised values map to `none` rather than being passed through: an
 * unknown status must not accidentally satisfy a `=== 'active'` check
 * somewhere downstream.
 */
export function toSubscriptionStatus(value: string | null | undefined): SubscriptionStatus {
  switch (value) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'canceled':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
      return value;
    default:
      return 'none';
  }
}

function toIso(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Finds the NetShift user a Stripe object belongs to.
 *
 * Three routes, in order of reliability: the metadata we set at checkout, the
 * `client_reference_id` we also set, and finally the stored customer id. Having
 * all three matters because a subscription created from the Stripe dashboard
 * has no metadata, and a customer created by an earlier failed checkout may be
 * the only link left.
 */
export async function resolveUserId(params: {
  metadataUserId?: string | null;
  clientReferenceId?: string | null;
  customerId?: string | null;
}): Promise<string | null> {
  const direct = params.metadataUserId ?? params.clientReferenceId;
  if (direct && /^[0-9a-f-]{36}$/i.test(direct)) return direct;

  if (params.customerId) {
    const { data } = await serviceClient()
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', params.customerId)
      .maybeSingle<{ user_id: string }>();
    if (data?.user_id) return data.user_id;

    // Last resort: ask Stripe what metadata the customer carries. A customer
    // created by our own checkout always has it.
    try {
      const customer = await stripeClient().customers.retrieve(params.customerId);
      if (!customer.deleted && customer.metadata?.supabase_user_id) {
        return customer.metadata.supabase_user_id;
      }
    } catch (error) {
      logServerError('stripe.resolveUserId', error, { customerId: params.customerId });
    }
  }

  return null;
}

export interface SubscriptionSyncResult {
  userId: string;
  status: SubscriptionStatus;
  entitlement: 'free' | 'pro';
}

/**
 * Writes a Stripe subscription's state into `subscriptions`.
 *
 * `past_due_since` is preserved across updates rather than re-stamped, so the
 * grace-period clock measures from the *first* failed payment and cannot be
 * reset by Stripe's retry schedule producing further `past_due` events.
 */
export async function syncSubscription(
  userId: string,
  subscription: Stripe.Subscription,
  eventId?: string,
): Promise<SubscriptionSyncResult> {
  const db = serviceClient();
  const status = toSubscriptionStatus(subscription.status);

  const { data: existing } = await db
    .from('subscriptions')
    .select('past_due_since, status')
    .eq('user_id', userId)
    .maybeSingle<{ past_due_since: string | null; status: SubscriptionStatus | null }>();

  let pastDueSince: string | null = existing?.past_due_since ?? null;
  if (status === 'past_due') {
    // Only stamp it the first time; a later retry must not extend the grace.
    if (!pastDueSince) pastDueSince = new Date().toISOString();
  } else {
    // Any non-past_due status clears the clock.
    pastDueSince = null;
  }

  const currentPeriodEnd = toIso(subscription.current_period_end);
  const entitlement = resolveEntitlement({
    status,
    currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
    trialEnd: toIso(subscription.trial_end),
    pastDueSince,
  }).tier;

  const priceId = subscription.items?.data?.[0]?.price?.id ?? null;
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null;

  const { error } = await db
    .from('subscriptions')
    .upsert(
      {
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        stripe_price_id: priceId,
        status,
        entitlement,
        current_period_start: toIso(subscription.current_period_start),
        current_period_end: currentPeriodEnd,
        cancel_at_period_end: subscription.cancel_at_period_end ?? false,
        canceled_at: toIso(subscription.canceled_at),
        trial_end: toIso(subscription.trial_end),
        past_due_since: pastDueSince,
        last_stripe_event_id: eventId ?? null,
        last_stripe_event_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (error) {
    logServerError('stripe.syncSubscription', error, { userId, subscriptionId: subscription.id });
    throw error;
  }

  return { userId, status, entitlement };
}

/**
 * Records the Stripe customer id for a user without touching their status.
 *
 * Used at checkout creation, so that a webhook arriving before the user
 * returns from Stripe can still be attributed to them.
 */
export async function linkCustomer(userId: string, customerId: string): Promise<void> {
  const { error } = await serviceClient()
    .from('subscriptions')
    .upsert({ user_id: userId, stripe_customer_id: customerId }, { onConflict: 'user_id' });
  if (error) {
    logServerError('stripe.linkCustomer', error, { userId });
    throw error;
  }
}

/**
 * Returns the Stripe customer for a user, creating one if needed.
 *
 * The Supabase user id goes into the customer's metadata, which is what makes
 * every later webhook attributable even if our own row is lost.
 */
export async function ensureCustomer(userId: string, email: string | null): Promise<string> {
  const db = serviceClient();
  const { data } = await db
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (data?.stripe_customer_id) {
    // Verify it still exists; a customer deleted in the dashboard would
    // otherwise make every checkout fail with an opaque Stripe error.
    try {
      const existing = await stripeClient().customers.retrieve(data.stripe_customer_id);
      if (!existing.deleted) return data.stripe_customer_id;
    } catch {
      // Fall through and create a new one.
    }
  }

  const customer = await stripeClient().customers.create({
    email: email ?? undefined,
    metadata: { supabase_user_id: userId },
  });

  await linkCustomer(userId, customer.id);
  return customer.id;
}
