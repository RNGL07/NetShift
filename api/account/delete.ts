/**
 * POST /api/account/delete — permanent account deletion.
 *
 * Deleting an account is irreversible, so it requires more than being signed
 * in: the caller must retype their email address. That is the difference
 * between a deliberate action and a misclick on a phone, and it is the same
 * confirmation pattern the UI shows.
 *
 * The heavy lifting is `delete_user_account`, which removes Storage objects
 * first (Storage does not cascade) and then the auth user, which cascades to
 * every owned row.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../_lib/auth';
import { ApiError, methodGuard, noStore, ok, withErrorHandling } from '../_lib/http';
import { serviceClient } from '../_lib/supabase';
import { stripeClient } from '../_lib/stripe';
import { logServerError } from '../_lib/http';

export default withErrorHandling(
  'account.delete',
  async (req: VercelRequest, res: VercelResponse) => {
    if (!methodGuard(req, res, ['POST'])) return;
    noStore(res);

    const user = await requireUser(req);

    const confirmation = (req.body as { confirmEmail?: unknown } | undefined)?.confirmEmail;
    if (
      typeof confirmation !== 'string' ||
      !user.email ||
      confirmation.trim().toLowerCase() !== user.email.toLowerCase()
    ) {
      throw new ApiError(
        'invalid_request',
        'Type your email address exactly to confirm that you want to delete your account.',
      );
    }

    const db = serviceClient();

    // Cancel any live subscription first. Deleting the account without this
    // would leave the user being billed for something they can no longer reach.
    const { data: subscription } = await db
      .from('subscriptions')
      .select('stripe_subscription_id, status')
      .eq('user_id', user.id)
      .maybeSingle<{ stripe_subscription_id: string | null; status: string | null }>();

    if (
      subscription?.stripe_subscription_id &&
      ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status ?? '')
    ) {
      try {
        await stripeClient().subscriptions.cancel(subscription.stripe_subscription_id);
      } catch (error) {
        // A Stripe failure must not block deletion — the user asked to leave.
        // It is logged so the subscription can be cancelled by hand.
        logServerError('account.delete.stripe', error, { userId: user.id });
      }
    }

    const { data, error } = await db.rpc('delete_user_account', { p_user_id: user.id });
    if (error) {
      logServerError('account.delete', error, { userId: user.id });
      throw new ApiError(
        'server_error',
        'Your account could not be deleted. Please contact support.',
      );
    }

    ok(res, {
      deleted: true,
      details: data,
      message: 'Your account and all of its data have been deleted.',
    });
  },
);
