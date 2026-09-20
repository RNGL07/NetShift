import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  PAST_DUE_GRACE_DAYS,
  limitForOperation,
  resolveAiLimits,
  resolveEntitlement,
  tierAllows,
  withinLimit,
  type SubscriptionStatus,
} from './plans';

describe('tierAllows', () => {
  it('lets both tiers use free features', () => {
    expect(tierAllows('free', 'hours_to_pay')).toBe(true);
    expect(tierAllows('pro', 'hours_to_pay')).toBe(true);
  });

  it('withholds Pro features from the free tier', () => {
    expect(tierAllows('free', 'debt_scenarios')).toBe(false);
    expect(tierAllows('pro', 'debt_scenarios')).toBe(true);
  });

  it('covers every roadmap feature with an explicit tier', () => {
    for (const feature of Object.values(FEATURES)) {
      expect(['free', 'pro']).toContain(feature.tier);
      expect(feature.description.length).toBeGreaterThan(10);
    }
  });

  it('keeps AI market reports and explanations Pro-only', () => {
    expect(tierAllows('free', 'ai_market_reports')).toBe(false);
    expect(tierAllows('free', 'ai_explanations')).toBe(false);
  });

  it('keeps document parsing available to free users', () => {
    expect(tierAllows('free', 'document_parsing')).toBe(true);
  });
});

describe('withinLimit', () => {
  it('caps free users at one pay profile and one goal', () => {
    expect(withinLimit('free', 'payProfiles', 0)).toBe(true);
    expect(withinLimit('free', 'payProfiles', 1)).toBe(false);
    expect(withinLimit('free', 'activeGoals', 1)).toBe(false);
  });

  it('does not cap Pro on unlimited resources', () => {
    expect(withinLimit('pro', 'activeGoals', 500)).toBe(true);
    expect(withinLimit('pro', 'paycheckHistory', 10_000)).toBe(true);
  });

  it('gives free users the current and next paycheck plan only', () => {
    expect(withinLimit('free', 'paycheckPlans', 1)).toBe(true);
    expect(withinLimit('free', 'paycheckPlans', 2)).toBe(false);
  });
});

describe('resolveAiLimits', () => {
  it('falls back to the built-in defaults with no environment set', () => {
    expect(resolveAiLimits('free', {}).monthlyDocumentParses).toBe(5);
    expect(resolveAiLimits('pro', {}).monthlyDocumentParses).toBe(100);
  });

  it('honours an environment override', () => {
    const limits = resolveAiLimits('free', { NETSHIFT_FREE_MONTHLY_DOCUMENT_PARSES: '12' });
    expect(limits.monthlyDocumentParses).toBe(12);
  });

  it('treats a non-numeric override as absent rather than NaN', () => {
    expect(
      resolveAiLimits('free', { NETSHIFT_FREE_MONTHLY_DOCUMENT_PARSES: 'lots' })
        .monthlyDocumentParses,
    ).toBe(5);
  });

  it('supports an unlimited allowance', () => {
    expect(
      resolveAiLimits('pro', { NETSHIFT_PRO_MONTHLY_DOCUMENT_PARSES: '-1' }).monthlyDocumentParses,
    ).toBe(-1);
  });

  it('maps each operation to its own allowance', () => {
    const limits = resolveAiLimits('pro', {});
    expect(limitForOperation(limits, 'parse_paystub')).toBe(limits.monthlyDocumentParses);
    expect(limitForOperation(limits, 'market_report')).toBe(limits.monthlyMarketReports);
    expect(limitForOperation(limits, 'explain_paycheck')).toBe(limits.monthlyAiExplanations);
  });
});

describe('resolveEntitlement', () => {
  const now = new Date('2026-03-10T00:00:00Z');
  const future = '2026-04-01T00:00:00Z';
  const past = '2026-02-01T00:00:00Z';

  const entitle = (status: SubscriptionStatus, over: Record<string, unknown> = {}) =>
    resolveEntitlement(
      { status, currentPeriodEnd: future, cancelAtPeriodEnd: false, ...over },
      now,
    );

  it('grants Pro while active', () => {
    expect(entitle('active').tier).toBe('pro');
  });

  it('grants Pro during a trial', () => {
    const result = entitle('trialing', { trialEnd: future });
    expect(result.tier).toBe('pro');
    expect(result.accessEndsAt).toBe(future);
  });

  it('keeps Pro through the past_due grace period', () => {
    const result = entitle('past_due', { pastDueSince: '2026-03-08T00:00:00Z' });
    expect(result.tier).toBe('pro');
    expect(result.inGracePeriod).toBe(true);
    expect(result.reason).toContain(`${PAST_DUE_GRACE_DAYS} days`);
  });

  it('drops to free once the past_due grace period expires', () => {
    const result = entitle('past_due', { pastDueSince: '2026-02-01T00:00:00Z' });
    expect(result.tier).toBe('free');
    expect(result.inGracePeriod).toBe(false);
  });

  it('keeps Pro on a cancelled subscription until the paid period ends', () => {
    expect(entitle('canceled', { currentPeriodEnd: future }).tier).toBe('pro');
    expect(entitle('canceled', { currentPeriodEnd: past }).tier).toBe('free');
  });

  it('keeps Pro when cancel_at_period_end is set but the period is live', () => {
    const result = entitle('active', { cancelAtPeriodEnd: true });
    expect(result.tier).toBe('pro');
    expect(result.reason).toContain('set to end');
  });

  it('withholds Pro for unpaid, incomplete, paused, and absent subscriptions', () => {
    for (const status of [
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
      'none',
    ] as const) {
      expect(entitle(status).tier).toBe('free');
    }
  });

  it('gives every state a reason the billing screen can show', () => {
    for (const status of [
      'active',
      'trialing',
      'past_due',
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
      'none',
    ] as const) {
      expect(entitle(status).reason.length).toBeGreaterThan(10);
    }
  });

  it('treats a malformed period end as no period rather than throwing', () => {
    const result = entitle('canceled', { currentPeriodEnd: 'nonsense' });
    expect(result.tier).toBe('free');
    expect(result.accessEndsAt).toBeNull();
  });
});
