/**
 * POST /api/stripe/portal — opens the Stripe Customer Portal.
 *
 * Cancellation, payment-method updates, invoices, and plan changes all happen
 * in Stripe's own portal. That is a deliberate anti-dark-pattern choice: there
 * is no NetShift-built retention flow between a user and the cancel button.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth';
import { appUrl } from '../_lib/env';
import { ApiError, methodGuard, noStore, ok, withErrorHandling } from '../_lib/http';
import { BILLING_RATE_LIMIT, consumeRateLimit } from '../_lib/rateLimit';
import { serviceClient } from '../_lib/supabase';
import { stripeClient } from '../_lib/stripe';

export default withErrorHandling(
  'stripe.portal',
  async (req: VercelRequest, res: VercelResponse) => {
    if (!methodGuard(req, res, ['POST'])) return;
    noStore(res);

    const user = await requireUser(req);
    await consumeRateLimit(user.id, BILLING_RATE_LIMIT);

    const { data } = await serviceClient()
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle<{ stripe_customer_id: string | null }>();

    // No customer means they have never started checkout, so there is nothing to
    // manage. Saying so plainly beats sending them to an empty portal.
    if (!data?.stripe_customer_id) {
      throw new ApiError(
        'not_found',
        'There is no billing account to manage yet. Start a subscription first.',
      );
    }

    const session = await stripeClient().billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${appUrl()}/billing`,
    });

    ok(res, { url: session.url });
  },
);
