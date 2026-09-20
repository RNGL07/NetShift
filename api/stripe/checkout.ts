/**
 * POST /api/stripe/checkout — creates a Stripe Checkout session.
 *
 * Uses Stripe Checkout rather than a custom card form, so no card data ever
 * touches NetShift. The price comes from `STRIPE_PRO_PRICE_ID`: the amount is
 * configured in Stripe and is deliberately absent from this codebase, so
 * changing the price is a dashboard action rather than a deploy.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth.js';
import { appUrl } from '../_lib/env.js';
import { ApiError, methodGuard, noStore, ok, withErrorHandling } from '../_lib/http.js';
import { BILLING_RATE_LIMIT, consumeRateLimit } from '../_lib/rateLimit.js';
import { getEntitlement } from '../_lib/entitlements.js';
import { ensureCustomer, proPriceId, stripeClient, trialDays } from '../_lib/stripe.js';

export default withErrorHandling(
  'stripe.checkout',
  async (req: VercelRequest, res: VercelResponse) => {
    if (!methodGuard(req, res, ['POST'])) return;
    noStore(res);

    const user = await requireUser(req);
    await consumeRateLimit(user.id, BILLING_RATE_LIMIT);

    // Someone already on Pro should be sent to the portal to manage what they
    // have, not through checkout again — that would create a second subscription.
    const entitlement = await getEntitlement(user.id);
    if (entitlement.tier === 'pro' && entitlement.status !== 'canceled') {
      throw new ApiError('conflict', 'You already have an active NetShift Pro subscription.', {
        status: entitlement.status,
      });
    }

    const customerId = await ensureCustomer(user.id, user.email);
    const base = appUrl();
    const trial = trialDays();

    const session = await stripeClient().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      // Both of these carry the Supabase user id so every resulting webhook is
      // attributable, even one that arrives before the browser redirects back.
      client_reference_id: user.id,
      metadata: { supabase_user_id: user.id },
      subscription_data: {
        metadata: { supabase_user_id: user.id },
        ...(trial ? { trial_period_days: trial } : {}),
      },
      line_items: [{ price: proPriceId(), quantity: 1 }],
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      // The success URL carries a marker the app uses to *poll* for the webhook,
      // never to grant access on its own.
      success_url: `${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/billing?checkout=cancelled`,
    });

    if (!session.url) {
      throw new ApiError('upstream_unavailable', 'Could not start checkout. Please try again.');
    }

    ok(res, { url: session.url, sessionId: session.id });
  },
);
