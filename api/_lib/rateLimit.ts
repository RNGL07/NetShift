/**
 * Rate limiting for the AI and market-data endpoints.
 *
 * Implemented against the database rather than in memory, because serverless
 * functions do not share memory: an in-process counter resets on every cold
 * start and is per-instance, so it limits nothing under the traffic pattern
 * that actually matters. The AI usage counters already give us a durable,
 * atomic per-user counter, and this adds a short-window one on top for burst
 * control.
 *
 * The limit is per user, not per IP: every endpoint here requires
 * authentication, and a per-IP limit would punish everyone behind one
 * workplace NAT — which, for an app aimed at people at the same plant, is a
 * realistic way to lock out a whole shift.
 */

import { ApiError, logServerError } from './http';
import { serviceClient } from './supabase';

export interface RateLimitRule {
  /** A name for the bucket, e.g. 'ai'. */
  bucket: string;
  /** Requests allowed within the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export const AI_RATE_LIMIT: RateLimitRule = { bucket: 'ai', limit: 10, windowSeconds: 60 };
export const PRICES_RATE_LIMIT: RateLimitRule = { bucket: 'prices', limit: 20, windowSeconds: 60 };
export const BILLING_RATE_LIMIT: RateLimitRule = {
  bucket: 'billing',
  limit: 10,
  windowSeconds: 60,
};

/**
 * Consumes one token from a user's bucket, or throws `rate_limited`.
 *
 * A failure to *check* the limit is not treated as a failure of the request:
 * if the rate-limit table is unavailable, the AI allowance check downstream is
 * still a hard cap on cost, so refusing every request would be a worse outcome
 * than briefly allowing bursts.
 */
export async function consumeRateLimit(
  userId: string,
  rule: RateLimitRule,
  now: Date = new Date(),
): Promise<void> {
  const windowStart = new Date(
    Math.floor(now.getTime() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000,
  );

  const { data, error } = await serviceClient().rpc('consume_rate_limit', {
    p_user_id: userId,
    p_bucket: rule.bucket,
    p_window_start: windowStart.toISOString(),
    p_limit: rule.limit,
  });

  if (error) {
    logServerError('rateLimit.consume', error, { userId, bucket: rule.bucket });
    return;
  }

  if (data === null || data === undefined) {
    const retryAfter = Math.ceil(
      (windowStart.getTime() + rule.windowSeconds * 1000 - now.getTime()) / 1000,
    );
    throw new ApiError(
      'rate_limited',
      `That is a lot of requests at once. Try again in ${Math.max(1, retryAfter)} seconds.`,
      { retryAfterSeconds: Math.max(1, retryAfter) },
    );
  }
}
