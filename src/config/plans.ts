/**
 * Plan definitions and the feature gate.
 *
 * This file is imported by **both** the browser and the serverless functions,
 * which is deliberate: the UI and the API must agree on exactly which features
 * are Pro. The browser uses it to decide what to *show*; the server uses it to
 * decide what to *allow*. Hiding a button is never the enforcement.
 *
 * Price amounts live in Stripe, never here — see `STRIPE_PRO_PRICE_ID`.
 */

export type PlanTier = 'free' | 'pro';

export type FeatureKey =
  // Free
  | 'hours_to_pay'
  | 'target_to_hours'
  | 'pay_profile'
  | 'wage_ladder'
  | 'hours_logging'
  | 'paycheck_forecast'
  | 'paycheck_audit_basic'
  | 'shift_value_basic'
  | 'investments'
  | 'market_prices'
  | 'document_parsing'
  // Pro
  | 'paycheck_audit_full'
  | 'anomaly_detection'
  | 'paycheck_history_unlimited'
  | 'paycheck_plan_future'
  | 'recurring_bills'
  | 'saved_paycheck_scenarios'
  | 'multiple_goals'
  | 'goal_projections'
  | 'buffer_recommendations'
  | 'overtime_dependency'
  | 'debt_scenarios'
  | 'saved_shift_scenarios'
  | 'rotation_automation'
  | 'bonus_planner'
  | 'ai_explanations'
  | 'ai_market_reports'
  | 'data_export';

export interface FeatureDefinition {
  key: FeatureKey;
  name: string;
  tier: PlanTier;
  /** Shown on the locked-feature preview. */
  description: string;
  /** Which nav section the feature belongs to. */
  area: string;
}

export const FEATURES: Record<FeatureKey, FeatureDefinition> = {
  hours_to_pay: {
    key: 'hours_to_pay',
    name: 'Hours → Pay calculator',
    tier: 'free',
    description: 'Turn a week or two of hours into an estimated paycheck.',
    area: 'calculators',
  },
  target_to_hours: {
    key: 'target_to_hours',
    name: 'Target → Hours calculator',
    tier: 'free',
    description: 'Work backwards from a take-home target to the hours it takes.',
    area: 'calculators',
  },
  pay_profile: {
    key: 'pay_profile',
    name: 'Pay profile',
    tier: 'free',
    description: 'One active pay profile with your rate, premiums, and overtime rules.',
    area: 'pay-profile',
  },
  wage_ladder: {
    key: 'wage_ladder',
    name: 'Wage ladder',
    tier: 'free',
    description: 'Track where you are on your wage progression and what the next step pays.',
    area: 'pay-profile',
  },
  hours_logging: {
    key: 'hours_logging',
    name: 'Hours logging',
    tier: 'free',
    description: 'Log daily hours so forecasts and audits have something real to work from.',
    area: 'hours',
  },
  paycheck_forecast: {
    key: 'paycheck_forecast',
    name: 'Current and next paycheck',
    tier: 'free',
    description: 'Plan the paycheck you are in and the one after it.',
    area: 'paycheck-plan',
  },
  paycheck_audit_basic: {
    key: 'paycheck_audit_basic',
    name: 'Basic paycheck audit',
    tier: 'free',
    description: 'Compare expected gross and hours against what the stub says.',
    area: 'paycheck-audit',
  },
  shift_value_basic: {
    key: 'shift_value_basic',
    name: 'Is this shift worth it?',
    tier: 'free',
    description: 'Price one extra shift after taxes and costs.',
    area: 'shift-value',
  },
  investments: {
    key: 'investments',
    name: 'Investment accounts',
    tier: 'free',
    description: 'Track accounts and holdings by hand.',
    area: 'investments',
  },
  market_prices: {
    key: 'market_prices',
    name: 'Live market prices',
    tier: 'free',
    description: 'Refresh holding prices from real market data.',
    area: 'investments',
  },
  document_parsing: {
    key: 'document_parsing',
    name: 'Document parsing',
    tier: 'free',
    description: 'Read pay stubs and wage sheets automatically, within your monthly allowance.',
    area: 'documents',
  },

  paycheck_audit_full: {
    key: 'paycheck_audit_full',
    name: 'Full paycheck reconciliation',
    tier: 'pro',
    description: 'Line-by-line comparison of every earning, premium, and deduction.',
    area: 'paycheck-audit',
  },
  anomaly_detection: {
    key: 'anomaly_detection',
    name: 'Historical anomaly detection',
    tier: 'pro',
    description: 'Flag paychecks that sit far outside your own normal.',
    area: 'paycheck-audit',
  },
  paycheck_history_unlimited: {
    key: 'paycheck_history_unlimited',
    name: 'Unlimited paycheck history',
    tier: 'pro',
    description: 'Keep every paycheck instead of the most recent few.',
    area: 'paychecks',
  },
  paycheck_plan_future: {
    key: 'paycheck_plan_future',
    name: 'Future paycheck plans',
    tier: 'pro',
    description: 'Plan out as many paychecks ahead as you like.',
    area: 'paycheck-plan',
  },
  recurring_bills: {
    key: 'recurring_bills',
    name: 'Recurring bills',
    tier: 'pro',
    description: 'Bills that repeat weekly, monthly, quarterly, or annually.',
    area: 'paycheck-plan',
  },
  saved_paycheck_scenarios: {
    key: 'saved_paycheck_scenarios',
    name: 'Saved paycheck scenarios',
    tier: 'pro',
    description: 'Save and compare different versions of a paycheck plan.',
    area: 'paycheck-plan',
  },
  multiple_goals: {
    key: 'multiple_goals',
    name: 'Multiple goals',
    tier: 'pro',
    description: 'Run more than one savings goal at a time.',
    area: 'goals',
  },
  goal_projections: {
    key: 'goal_projections',
    name: 'Goal funding projections',
    tier: 'pro',
    description: 'See the overtime hours and completion dates behind each goal.',
    area: 'goals',
  },
  buffer_recommendations: {
    key: 'buffer_recommendations',
    name: 'Variable-income buffer',
    tier: 'pro',
    description: 'A buffer recommendation built from your own paycheck history.',
    area: 'buffer',
  },
  overtime_dependency: {
    key: 'overtime_dependency',
    name: 'Overtime-dependency analysis',
    tier: 'pro',
    description: 'How much of your monthly commitment depends on overtime continuing.',
    area: 'buffer',
  },
  debt_scenarios: {
    key: 'debt_scenarios',
    name: 'Debt payoff scenarios',
    tier: 'pro',
    description: 'Snowball vs avalanche, extra payments, and extra-shift scenarios.',
    area: 'debt',
  },
  saved_shift_scenarios: {
    key: 'saved_shift_scenarios',
    name: 'Saved shift scenarios',
    tier: 'pro',
    description: 'Save shift evaluations and link them to goals and debts.',
    area: 'shift-value',
  },
  rotation_automation: {
    key: 'rotation_automation',
    name: 'Rotation calendar',
    tier: 'pro',
    description: 'Define a rotation once and have it fill in your schedule and forecasts.',
    area: 'rotations',
  },
  bonus_planner: {
    key: 'bonus_planner',
    name: 'Bonus and profit-sharing planner',
    tier: 'pro',
    description: 'Plan a bonus before it lands and compare it to what actually arrived.',
    area: 'bonuses',
  },
  ai_explanations: {
    key: 'ai_explanations',
    name: 'Personalised AI explanations',
    tier: 'pro',
    description: 'A plain-language walk-through of your own paycheck.',
    area: 'paychecks',
  },
  ai_market_reports: {
    key: 'ai_market_reports',
    name: 'AI market reports',
    tier: 'pro',
    description: 'An educational market summary generated on demand.',
    area: 'market-reports',
  },
  data_export: {
    key: 'data_export',
    name: 'Data export',
    tier: 'pro',
    description: 'Download your paychecks, audits, and plans as CSV or JSON.',
    area: 'settings',
  },
};

export const PRO_FEATURES = Object.values(FEATURES)
  .filter((f) => f.tier === 'pro')
  .map((f) => f.key);

export const FREE_FEATURES = Object.values(FEATURES)
  .filter((f) => f.tier === 'free')
  .map((f) => f.key);

/** The single source of truth for "can this tier use this feature?". */
export function tierAllows(tier: PlanTier, feature: FeatureKey): boolean {
  const definition = FEATURES[feature];
  if (!definition) return false;
  return definition.tier === 'free' || tier === 'pro';
}

// ---------------------------------------------------------------------------
// Quantity limits
// ---------------------------------------------------------------------------

export interface PlanLimits {
  /** Active pay profiles. */
  payProfiles: number;
  /** Active (not yet completed) goals. */
  activeGoals: number;
  /** Paychecks retained in history. */
  paycheckHistory: number;
  /** Paycheck plans that may exist at once (current + next for free). */
  paycheckPlans: number;
  /** Saved shift scenarios. */
  savedShiftScenarios: number;
  /** Saved debt payoff scenarios. */
  savedDebtScenarios: number;
  /** Rotation patterns. */
  rotationPatterns: number;
  /** Tracked bonuses. */
  bonuses: number;
  /** Recurring (non one-off) bills. */
  recurringBills: number;
}

/** `Infinity` means "no cap". */
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    payProfiles: 1,
    activeGoals: 1,
    paycheckHistory: 12,
    paycheckPlans: 2,
    savedShiftScenarios: 0,
    savedDebtScenarios: 0,
    rotationPatterns: 0,
    bonuses: 0,
    recurringBills: 0,
  },
  pro: {
    payProfiles: 10,
    activeGoals: Number.POSITIVE_INFINITY,
    paycheckHistory: Number.POSITIVE_INFINITY,
    paycheckPlans: Number.POSITIVE_INFINITY,
    savedShiftScenarios: Number.POSITIVE_INFINITY,
    savedDebtScenarios: Number.POSITIVE_INFINITY,
    rotationPatterns: 10,
    bonuses: Number.POSITIVE_INFINITY,
    recurringBills: Number.POSITIVE_INFINITY,
  },
};

export function limitFor(tier: PlanTier, key: keyof PlanLimits): number {
  return PLAN_LIMITS[tier][key];
}

export function withinLimit(tier: PlanTier, key: keyof PlanLimits, currentCount: number): boolean {
  return currentCount < limitFor(tier, key);
}

// ---------------------------------------------------------------------------
// AI usage allowance
// ---------------------------------------------------------------------------

export type AiOperation =
  | 'parse_paystub'
  | 'parse_wage_sheet'
  | 'explain_paycheck'
  | 'market_report';

export const AI_OPERATIONS: Record<AiOperation, { name: string; tier: PlanTier; countsTowardAllowance: boolean }> = {
  parse_paystub: { name: 'Pay-stub parsing', tier: 'free', countsTowardAllowance: true },
  parse_wage_sheet: { name: 'Wage-sheet parsing', tier: 'free', countsTowardAllowance: true },
  explain_paycheck: { name: 'Paycheck explanation', tier: 'pro', countsTowardAllowance: false },
  market_report: { name: 'Market report', tier: 'pro', countsTowardAllowance: false },
};

/**
 * Monthly document-parse allowance per tier.
 *
 * Read from environment variables so the allowance can be tuned without a code
 * change, per the product requirement that limits stay configurable.
 * `-1` means unlimited.
 */
export interface AiLimits {
  monthlyDocumentParses: number;
  monthlyAiExplanations: number;
  monthlyMarketReports: number;
}

export const DEFAULT_AI_LIMITS: Record<PlanTier, AiLimits> = {
  free: { monthlyDocumentParses: 5, monthlyAiExplanations: 0, monthlyMarketReports: 0 },
  pro: { monthlyDocumentParses: 100, monthlyAiExplanations: 60, monthlyMarketReports: 30 },
};

/** Applies environment overrides on top of the defaults. */
export function resolveAiLimits(
  tier: PlanTier,
  env: Record<string, string | undefined> = {},
): AiLimits {
  const defaults = DEFAULT_AI_LIMITS[tier];
  const read = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const prefix = tier === 'pro' ? 'PRO' : 'FREE';
  return {
    monthlyDocumentParses: read(`NETSHIFT_${prefix}_MONTHLY_DOCUMENT_PARSES`, defaults.monthlyDocumentParses),
    monthlyAiExplanations: read(`NETSHIFT_${prefix}_MONTHLY_AI_EXPLANATIONS`, defaults.monthlyAiExplanations),
    monthlyMarketReports: read(`NETSHIFT_${prefix}_MONTHLY_MARKET_REPORTS`, defaults.monthlyMarketReports),
  };
}

export function limitForOperation(limits: AiLimits, operation: AiOperation): number {
  switch (operation) {
    case 'parse_paystub':
    case 'parse_wage_sheet':
      return limits.monthlyDocumentParses;
    case 'explain_paycheck':
      return limits.monthlyAiExplanations;
    case 'market_report':
      return limits.monthlyMarketReports;
  }
}

export function isUnlimited(limit: number): boolean {
  return limit < 0 || !Number.isFinite(limit);
}

// ---------------------------------------------------------------------------
// Subscription status → entitlement
// ---------------------------------------------------------------------------

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused'
  | 'none';

/**
 * Which Stripe subscription statuses grant Pro.
 *
 * - `active` / `trialing` — paid or in a valid trial. Full Pro.
 * - `past_due` — a payment failed but Stripe is still retrying. Pro continues
 *   through a short grace period (see `PAST_DUE_GRACE_DAYS`) rather than
 *   cutting access off on the first failed card, which is the usual cause of a
 *   support ticket and not of abuse.
 * - `canceled` — access continues to the end of the period already paid for,
 *   which is why the check is against `currentPeriodEnd` rather than status
 *   alone. No dark patterns: cancelling never takes away time already bought.
 * - everything else — free tier.
 */
export const PAST_DUE_GRACE_DAYS = 7;

export interface EntitlementInput {
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd?: string | null;
  /** When the subscription first entered `past_due`. */
  pastDueSince?: string | null;
}

export interface Entitlement {
  tier: PlanTier;
  status: SubscriptionStatus;
  /** Why the tier is what it is, in one sentence, for the billing screen. */
  reason: string;
  /** `true` when Pro is running on grace rather than a good payment. */
  inGracePeriod: boolean;
  /** When Pro access ends if nothing changes. */
  accessEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
}

export function resolveEntitlement(input: EntitlementInput, now: Date = new Date()): Entitlement {
  const periodEnd = input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null;
  const periodEndValid = periodEnd && Number.isFinite(periodEnd.getTime()) ? periodEnd : null;
  const periodActive = periodEndValid !== null && periodEndValid.getTime() > now.getTime();

  const base = {
    status: input.status,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    accessEndsAt: periodEndValid ? periodEndValid.toISOString() : null,
  };

  switch (input.status) {
    case 'active':
      return {
        ...base,
        tier: 'pro',
        inGracePeriod: false,
        reason: input.cancelAtPeriodEnd
          ? 'Your subscription is set to end at the end of the current period. Pro stays on until then.'
          : 'Your subscription is active.',
      };

    case 'trialing':
      return {
        ...base,
        tier: 'pro',
        inGracePeriod: false,
        accessEndsAt: input.trialEnd ?? base.accessEndsAt,
        reason: 'You are in a trial period with full Pro access.',
      };

    case 'past_due': {
      const since = input.pastDueSince ? new Date(input.pastDueSince) : null;
      const graceEnds =
        since && Number.isFinite(since.getTime())
          ? new Date(since.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000)
          : null;
      const inGrace = graceEnds === null || graceEnds.getTime() > now.getTime();
      return {
        ...base,
        tier: inGrace ? 'pro' : 'free',
        inGracePeriod: inGrace,
        accessEndsAt: graceEnds ? graceEnds.toISOString() : base.accessEndsAt,
        reason: inGrace
          ? `A payment did not go through. Pro stays on for up to ${PAST_DUE_GRACE_DAYS} days while Stripe retries — update your card in the billing portal to avoid interruption.`
          : 'A payment did not go through and the grace period has ended. Update your card to restore Pro.',
      };
    }

    case 'canceled':
      // Stripe keeps `current_period_end` on a cancelled subscription; access
      // runs to the end of what was already paid for.
      return {
        ...base,
        tier: periodActive ? 'pro' : 'free',
        inGracePeriod: false,
        reason: periodActive
          ? 'Your subscription is cancelled. Pro stays on until the end of the period you have already paid for.'
          : 'Your subscription has ended.',
      };

    case 'paused':
      return { ...base, tier: 'free', inGracePeriod: false, reason: 'Your subscription is paused.' };

    case 'unpaid':
      return {
        ...base,
        tier: 'free',
        inGracePeriod: false,
        reason: 'Your subscription is unpaid. Update your payment method to restore Pro.',
      };

    case 'incomplete':
      return {
        ...base,
        tier: 'free',
        inGracePeriod: false,
        reason: 'Your first payment has not completed yet. Pro turns on as soon as it does.',
      };

    case 'incomplete_expired':
      return {
        ...base,
        tier: 'free',
        inGracePeriod: false,
        reason: 'The checkout was not completed, so no subscription was created.',
      };

    case 'none':
    default:
      return { ...base, tier: 'free', inGracePeriod: false, reason: 'You are on the free plan.' };
  }
}

export const FREE_ENTITLEMENT: Entitlement = {
  tier: 'free',
  status: 'none',
  reason: 'You are on the free plan.',
  inGracePeriod: false,
  accessEndsAt: null,
  cancelAtPeriodEnd: false,
};
