/**
 * Server-side entitlement and allowance checks.
 *
 * This is the enforcement point the product requirement is about: the browser
 * may hide a Pro button, but nothing is actually withheld until this module
 * says so. Every Pro endpoint calls `requirePro`, and every AI endpoint calls
 * `claimAiUsage` *before* contacting the provider.
 */

import {
  FREE_ENTITLEMENT,
  resolveAiLimits,
  resolveEntitlement,
  limitForOperation,
  isUnlimited,
  tierAllows,
  type AiOperation,
  type Entitlement,
  type FeatureKey,
  type PlanTier,
  type SubscriptionStatus,
} from '../../src/config/plans.js';
import { aiLimitEnv } from './env.js';
import { ApiError, logServerError } from './http.js';
import { serviceClient } from './supabase.js';

interface SubscriptionRow {
  status: SubscriptionStatus | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  trial_end: string | null;
  past_due_since: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
}

/**
 * Reads the user's subscription and derives their tier.
 *
 * Reads through the *service* client on purpose: the entitlement must be the
 * database's view of the subscription, not something influenced by a token the
 * caller supplied. A missing row means free, which is the safe default.
 */
export async function getEntitlement(userId: string): Promise<Entitlement> {
  const { data, error } = await serviceClient()
    .from('subscriptions')
    .select(
      'status, current_period_end, cancel_at_period_end, trial_end, past_due_since, stripe_customer_id, stripe_subscription_id, stripe_price_id',
    )
    .eq('user_id', userId)
    .maybeSingle<SubscriptionRow>();

  if (error) {
    logServerError('entitlements.get', error, { userId });
    // Failing closed: an unreadable subscription is treated as free rather
    // than granting Pro on an infrastructure hiccup.
    return FREE_ENTITLEMENT;
  }
  if (!data) return FREE_ENTITLEMENT;

  return resolveEntitlement({
    status: data.status ?? 'none',
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end ?? false,
    trialEnd: data.trial_end,
    pastDueSince: data.past_due_since,
  });
}

export async function getTier(userId: string): Promise<PlanTier> {
  return (await getEntitlement(userId)).tier;
}

/** Throws `pro_required` unless the user's tier covers the feature. */
export async function requireFeature(userId: string, feature: FeatureKey): Promise<Entitlement> {
  const entitlement = await getEntitlement(userId);
  if (!tierAllows(entitlement.tier, feature)) {
    throw new ApiError('pro_required', 'This feature is part of NetShift Pro.', {
      feature,
      currentTier: entitlement.tier,
    });
  }
  return entitlement;
}

export async function requirePro(userId: string): Promise<Entitlement> {
  const entitlement = await getEntitlement(userId);
  if (entitlement.tier !== 'pro') {
    throw new ApiError('pro_required', 'This feature is part of NetShift Pro.', {
      currentTier: entitlement.tier,
    });
  }
  return entitlement;
}

// ---------------------------------------------------------------------------
// AI allowance
// ---------------------------------------------------------------------------

/** `YYYY-MM` in UTC, which is what the counter table is keyed on. */
export function usageMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface UsageSnapshot {
  operation: AiOperation;
  used: number;
  limit: number;
  remaining: number;
  unlimited: boolean;
  month: string;
}

/** Reads current usage without consuming any. */
export async function readUsage(
  userId: string,
  tier: PlanTier,
  operation: AiOperation,
  now: Date = new Date(),
): Promise<UsageSnapshot> {
  const month = usageMonth(now);
  const limits = resolveAiLimits(tier, aiLimitEnv());
  const limit = limitForOperation(limits, operation);

  const { data } = await serviceClient()
    .from('ai_usage_counters')
    .select('used')
    .eq('user_id', userId)
    .eq('usage_month', month)
    .eq('operation', operation)
    .maybeSingle<{ used: number }>();

  const used = data?.used ?? 0;
  const unlimited = isUnlimited(limit);

  return {
    operation,
    used,
    limit,
    remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
    unlimited,
    month,
  };
}

export interface UsageClaim {
  month: string;
  operation: AiOperation;
  used: number;
  limit: number;
  unlimited: boolean;
  /** Returns the claim so a failed provider call does not cost the user a parse. */
  release: () => Promise<void>;
}

/**
 * Consumes one unit of allowance, or throws.
 *
 * The increment happens in the database in a single statement
 * (`claim_ai_usage`), so two uploads racing at "4 of 5 used" cannot both
 * succeed. The claim is taken *before* the provider is called and released if
 * that call fails.
 */
export async function claimAiUsage(
  userId: string,
  tier: PlanTier,
  operation: AiOperation,
  now: Date = new Date(),
): Promise<UsageClaim> {
  const month = usageMonth(now);
  const limits = resolveAiLimits(tier, aiLimitEnv());
  const limit = limitForOperation(limits, operation);
  const unlimited = isUnlimited(limit);

  if (limit === 0) {
    throw new ApiError(
      'pro_required',
      tier === 'free'
        ? 'This AI feature is part of NetShift Pro.'
        : 'This AI feature is not enabled on your plan.',
      { operation, limit },
    );
  }

  const db = serviceClient();
  const { data, error } = await db.rpc('claim_ai_usage', {
    p_user_id: userId,
    p_month: month,
    p_operation: operation,
    p_limit: unlimited ? -1 : limit,
  });

  if (error) {
    logServerError('entitlements.claim', error, { userId, operation });
    throw new ApiError('server_error', 'Could not check your usage allowance. Please try again.');
  }

  if (data === null || data === undefined) {
    throw new ApiError(
      'allowance_exhausted',
      tier === 'free'
        ? `You have used all ${limit} of this month's free document parses. Your allowance resets next month, and NetShift Pro raises it.`
        : `You have used all ${limit} of this month's allowance for this feature. It resets next month.`,
      { operation, limit, used: limit, month },
    );
  }

  return {
    month,
    operation,
    used: Number(data),
    limit,
    unlimited,
    release: async () => {
      const { error: releaseError } = await db.rpc('release_ai_usage', {
        p_user_id: userId,
        p_month: month,
        p_operation: operation,
      });
      if (releaseError) {
        logServerError('entitlements.release', releaseError, { userId, operation });
      }
    },
  };
}

/**
 * Records that an AI call happened.
 *
 * Deliberately records no document content and no extracted financial values —
 * only the operation, the model, token counts, and whether it worked.
 */
export async function recordAiUsage(params: {
  userId: string;
  operation: AiOperation;
  month: string;
  tier: PlanTier;
  model: string;
  countsTowardAllowance: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number;
  outcome: 'ok' | 'error';
  errorCode?: string;
}): Promise<void> {
  const { error } = await serviceClient()
    .from('ai_usage_events')
    .insert({
      user_id: params.userId,
      operation: params.operation,
      usage_month: params.month,
      counts_toward_allowance: params.countsTowardAllowance,
      tier_at_time: params.tier,
      model: params.model,
      input_tokens: params.inputTokens ?? null,
      output_tokens: params.outputTokens ?? null,
      duration_ms: params.durationMs ?? null,
      outcome: params.outcome,
      error_code: params.errorCode ?? null,
    });

  if (error) {
    // Usage accounting failing must not fail the user's request.
    logServerError('entitlements.record', error, {
      userId: params.userId,
      operation: params.operation,
    });
  }
}
