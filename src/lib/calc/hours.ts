/**
 * Hours → buckets.
 *
 * This is the single place NetShift decides how many of a week's hours are
 * regular, overtime, or double time. Everything downstream — the Hours→Pay
 * calculator, the paycheck audit, "is this shift worth it?", goal funding,
 * debt scenarios — calls through here, so there is exactly one overtime rule
 * to reason about and to test.
 *
 * Behaviour is carried over verbatim from the prototype's `weekTotals()`:
 *
 *   - Days Mon–Sat contribute `min(hours, dailyThreshold)` to a "regular pool";
 *     anything above the daily threshold is daily overtime.
 *   - Weekly overtime is whatever is left of the regular pool above the weekly
 *     threshold. Because daily overtime was already removed from the pool, an
 *     hour can never be counted as both daily and weekly overtime.
 *   - Sunday is held out of both thresholds and then added as regular,
 *     overtime, or double time according to the configured treatment.
 */

import { nonNegative, roundTo } from './money';

export type SundayTreatment = 'regular' | 'ot' | 'double';
export type ShiftDesignation = 'day' | 'evening' | 'night';

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type DayLabel = (typeof DAY_LABELS)[number];

export interface OvertimeRules {
  /** Hours in one day past which time is overtime. `null` disables daily OT. */
  dailyThreshold: number | null;
  /** Hours in one week past which time is overtime. `null` disables weekly OT. */
  weeklyThreshold: number | null;
  /** How Sunday hours are paid. */
  sundayTreatment: SundayTreatment;
  /** Multiplier applied to overtime hours. */
  overtimeMultiplier: number;
  /** Multiplier applied to double-time hours. */
  doubleTimeMultiplier: number;
}

export const DEFAULT_OVERTIME_RULES: OvertimeRules = {
  dailyThreshold: 8,
  weeklyThreshold: 40,
  sundayTreatment: 'regular',
  overtimeMultiplier: 1.5,
  doubleTimeMultiplier: 2,
};

export interface HourBuckets {
  regular: number;
  overtime: number;
  doubleTime: number;
}

export const EMPTY_BUCKETS: HourBuckets = { regular: 0, overtime: 0, doubleTime: 0 };

export function totalHours(buckets: HourBuckets): number {
  return buckets.regular + buckets.overtime + buckets.doubleTime;
}

export function addBuckets(a: HourBuckets, b: HourBuckets): HourBuckets {
  return {
    regular: a.regular + b.regular,
    overtime: a.overtime + b.overtime,
    doubleTime: a.doubleTime + b.doubleTime,
  };
}

export function scaleBuckets(buckets: HourBuckets, factor: number): HourBuckets {
  return {
    regular: buckets.regular * factor,
    overtime: buckets.overtime * factor,
    doubleTime: buckets.doubleTime * factor,
  };
}

export function roundBuckets(buckets: HourBuckets, places = 2): HourBuckets {
  return {
    regular: roundTo(buckets.regular, places),
    overtime: roundTo(buckets.overtime, places),
    doubleTime: roundTo(buckets.doubleTime, places),
  };
}

/** A week of hours, Monday first, Sunday last. Missing entries count as zero. */
export type WeekHours = readonly (number | string | null | undefined)[];

/**
 * Splits one week of daily hours into regular / overtime / double-time.
 *
 * `priorWeekHours` lets callers price an *additional* shift against hours
 * already worked in the same workweek — see `marginalWeekBuckets`.
 */
export function bucketWeek(
  days: WeekHours,
  rules: OvertimeRules = DEFAULT_OVERTIME_RULES,
): HourBuckets {
  const daily = Array.from({ length: 7 }, (_, i) => nonNegative(days[i]));
  const sunday = daily[6];
  const weekdays = daily.slice(0, 6);

  const dailyCap = rules.dailyThreshold;
  let dailyOvertime = 0;
  let regularPool = 0;

  for (const hours of weekdays) {
    if (dailyCap !== null && hours > dailyCap) {
      dailyOvertime += hours - dailyCap;
      regularPool += dailyCap;
    } else {
      regularPool += hours;
    }
  }

  const weeklyCap = rules.weeklyThreshold;
  const weeklyOvertime = weeklyCap === null ? 0 : Math.max(0, regularPool - weeklyCap);

  let regular = regularPool - weeklyOvertime;
  let overtime = dailyOvertime + weeklyOvertime;
  let doubleTime = 0;

  if (rules.sundayTreatment === 'ot') overtime += sunday;
  else if (rules.sundayTreatment === 'double') doubleTime += sunday;
  else regular += sunday;

  return { regular, overtime, doubleTime };
}

/**
 * The buckets a *newly added* block of hours lands in, given what has already
 * been worked in the same workweek.
 *
 * Adding 4 hours on top of a 40-hour week is not the same as 4 hours in
 * isolation: the incremental hours are overtime. This computes the difference
 * between the full week and the week without the addition, which is the only
 * way to get that right under combined daily + weekly rules.
 */
export function marginalWeekBuckets(
  priorDays: WeekHours,
  addedDays: WeekHours,
  rules: OvertimeRules = DEFAULT_OVERTIME_RULES,
): HourBuckets {
  const before = bucketWeek(priorDays, rules);
  const combined = Array.from(
    { length: 7 },
    (_, i) => nonNegative(priorDays[i]) + nonNegative(addedDays[i]),
  );
  const after = bucketWeek(combined, rules);
  return {
    regular: after.regular - before.regular,
    overtime: after.overtime - before.overtime,
    doubleTime: after.doubleTime - before.doubleTime,
  };
}

export interface RatePremiums {
  /** Added when the shift is anything other than a day shift. */
  shiftPremium: number;
  /** Added when the user holds a team-leader / role premium. */
  rolePremium: number;
  /** Whether the role premium applies. */
  hasRolePremium: boolean;
}

export const NO_PREMIUMS: RatePremiums = { shiftPremium: 0, rolePremium: 0, hasRolePremium: false };

/**
 * Base rate plus the per-hour premiums that apply.
 *
 * Premiums are added to the base rate *before* the overtime multiplier, which
 * is how the prototype did it and how most manufacturing contracts read (the
 * premium is part of the "regular rate of pay").
 */
export function effectiveRate(
  baseRate: number,
  designation: ShiftDesignation,
  premiums: RatePremiums = NO_PREMIUMS,
): number {
  let rate = nonNegative(baseRate);
  if (designation !== 'day') rate += nonNegative(premiums.shiftPremium);
  if (premiums.hasRolePremium) rate += nonNegative(premiums.rolePremium);
  return rate;
}

/** Gross pay for a set of buckets at one effective rate. */
export function grossFromBuckets(
  buckets: HourBuckets,
  rate: number,
  rules: OvertimeRules = DEFAULT_OVERTIME_RULES,
): number {
  return (
    buckets.regular * rate +
    buckets.overtime * rate * rules.overtimeMultiplier +
    buckets.doubleTime * rate * rules.doubleTimeMultiplier
  );
}

/**
 * "Straight-time equivalent" hours — hours weighted by their multiplier.
 * Useful when solving for how many hours are needed to reach a gross figure.
 */
export function weightedHours(
  buckets: HourBuckets,
  rules: OvertimeRules = DEFAULT_OVERTIME_RULES,
): number {
  return (
    buckets.regular +
    buckets.overtime * rules.overtimeMultiplier +
    buckets.doubleTime * rules.doubleTimeMultiplier
  );
}

export type PayPeriodKind = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

/** Weeks in one pay period. Monthly and semi-monthly are averages, not exact. */
export function weeksInPeriod(period: PayPeriodKind): number {
  switch (period) {
    case 'weekly':
      return 1;
    case 'biweekly':
      return 2;
    case 'semimonthly':
      return 52 / 24;
    case 'monthly':
      return 52 / 12;
  }
}

/** Paychecks per year, used to turn a per-paycheck figure into an annual one. */
export function paychecksPerYear(period: PayPeriodKind): number {
  switch (period) {
    case 'weekly':
      return 52;
    case 'biweekly':
      return 26;
    case 'semimonthly':
      return 24;
    case 'monthly':
      return 12;
  }
}

/** Hours that are paid at straight time across a whole pay period. */
export function regularHoursThreshold(
  period: PayPeriodKind,
  rules: OvertimeRules = DEFAULT_OVERTIME_RULES,
): number {
  const weekly = rules.weeklyThreshold ?? 40;
  return weekly * weeksInPeriod(period);
}
