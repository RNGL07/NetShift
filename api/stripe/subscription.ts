/**
 * GET /api/stripe/subscription — the caller's current billing state.
 *
 * This is what the billing screen polls after a user returns from Checkout.
 * It reports whatever the webhook has written; it never infers a subscription
 * from the fact that someone landed on the success URL.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth';
import { methodGuard, noStore, ok, withErrorHandling } from '../_lib/http';
import { getEntitlement, readUsage } from '../_lib/entitlements';
import { serviceClient } from '../_lib/supabase';

interface Row {
  stripe_price_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  trial_end: string | null;
  stripe_customer_id: string | null;
}

export default withErrorHandling(
  'stripe.subscription',
  async (req: VercelRequest, res: VercelResponse) => {
    if (!methodGuard(req, res, ['GET'])) return;
    noStore(res);

    const user = await requireUser(req);
    const entitlement = await getEntitlement(user.id);

    const { data } = await serviceClient()
      .from('subscriptions')
      .select(
        'stripe_price_id, current_period_start, current_period_end, cancel_at_period_end, trial_end, stripe_customer_id',
      )
      .eq('user_id', user.id)
      .maybeSingle<Row>();

    // The document-parse allowance is shown alongside the plan, because
    // "how many parses do I have left" is the question a free user actually has.
    const parseUsage = await readUsage(user.id, entitlement.tier, 'parse_paystub');

    ok(res, {
      tier: entitlement.tier,
      status: entitlement.status,
      reason: entitlement.reason,
      inGracePeriod: entitlement.inGracePeriod,
      cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
      accessEndsAt: entitlement.accessEndsAt,
      currentPeriodStart: data?.current_period_start ?? null,
      currentPeriodEnd: data?.current_period_end ?? null,
      trialEnd: data?.trial_end ?? null,
      priceId: data?.stripe_price_id ?? null,
      hasBillingAccount: Boolean(data?.stripe_customer_id),
      documentParses: {
        used: parseUsage.used,
        limit: parseUsage.unlimited ? null : parseUsage.limit,
        remaining: parseUsage.unlimited ? null : parseUsage.remaining,
        month: parseUsage.month,
      },
    });
  },
);
