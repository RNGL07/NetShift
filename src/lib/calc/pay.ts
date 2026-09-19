/**
 * The two calculators NetShift started life as: Hours → Pay and Target → Hours.
 *
 * Both return not just an answer but the pieces the answer was built from, so
 * the UI can show its working instead of a magic number.
 */

import {
  DEFAULT_OVERTIME_RULES,
  EMPTY_BUCKETS,
  NO_PREMIUMS,
  addBuckets,
  bucketWeek,
  effectiveRate,
  grossFromBuckets,
  regularHoursThreshold,
  scaleBuckets,
  totalHours,
  weeksInPeriod,
  type HourBuckets,
  type OvertimeRules,
  type PayPeriodKind,
  type RatePremiums,
  type ShiftDesignation,
  type SundayTreatment,
  type WeekHours,
} from './hours';
import { clamp, nonNegative, num, roundMoney, roundTo } from './money';

// ---------------------------------------------------------------------------
// Hours → Pay
// ---------------------------------------------------------------------------

export interface WeekInput {
  days: WeekHours;
  sundayTreatment: SundayTreatment;
  designation: ShiftDesignation;
}

export interface HoursToPayInput {
  baseRate: number;
  payPeriod: PayPeriodKind;
  premiums?: RatePremiums;
  rules?: OvertimeRules;
  /** Estimated share of gross withheld, as a percentage (0–100). */
  deductionPct: number;
  perDiemRate?: number;
  perDiemDaysPerWeek?: number;
  /** Per-week detail. Provide one week for weekly, two for biweekly. */
  weeks?: WeekInput[];
  /**
   * Alternative to `weeks`: totals already split into regular/OT hours, which
   * is what a user reading straight off a stub has.
   */
  totals?: {
    regularHours: number;
    overtimeHours: number;
    doubleTimeHours: number;
    designation: ShiftDesignation;
  };
}

export interface PayLineItem {
  label: string;
  hours: number;
  rate: number;
  multiplier: number;
  amount: number;
}

export interface HoursToPayResult {
  buckets: HourBuckets;
  totalHours: number;
  lines: PayLineItem[];
  gross: number;
  /** Gross less the estimated withholding percentage. */
  estimatedTakeHomeBeforePerDiem: number;
  perDiemTotal: number;
  /** Take-home including non-taxed per diem. */
  estimatedTakeHome: number;
  deductionPct: number;
  keepPct: number;
  /** Plain-English note describing how the buckets were produced. */
  note: string;
  /** Per-week effective rates, for transparency. */
  effectiveRates: { label: string; rate: number }[];
}

function periodWeekCount(period: PayPeriodKind): number {
  return weeksInPeriod(period);
}

/**
 * Turns hours into an estimated paycheck.
 *
 * Per diem is deliberately added *after* the withholding estimate: a non-taxed
 * reimbursement is not part of gross and must never be reduced by the
 * deduction percentage.
 */
export function hoursToPay(input: HoursToPayInput): HoursToPayResult {
  const rules = input.rules ?? DEFAULT_OVERTIME_RULES;
  const premiums = input.premiums ?? NO_PREMIUMS;
  const baseRate = nonNegative(input.baseRate);
  const deductionPct = clamp(num(input.deductionPct, 0), 0, 100);
  const weeksCount = periodWeekCount(input.payPeriod);

  const perDiemTotal = roundMoney(
    nonNegative(input.perDiemRate) * nonNegative(input.perDiemDaysPerWeek) * weeksCount,
  );

  const lines: PayLineItem[] = [];
  const effectiveRates: { label: string; rate: number }[] = [];
  let buckets: HourBuckets = { ...EMPTY_BUCKETS };
  let gross = 0;
  let note: string;

  const pushLines = (label: string, b: HourBuckets, rate: number) => {
    if (b.regular > 0) {
      lines.push({
        label: `${label}regular`,
        hours: roundTo(b.regular, 2),
        rate,
        multiplier: 1,
        amount: roundMoney(b.regular * rate),
      });
    }
    if (b.overtime > 0) {
      lines.push({
        label: `${label}overtime`,
        hours: roundTo(b.overtime, 2),
        rate,
        multiplier: rules.overtimeMultiplier,
        amount: roundMoney(b.overtime * rate * rules.overtimeMultiplier),
      });
    }
    if (b.doubleTime > 0) {
      lines.push({
        label: `${label}double time`,
        hours: roundTo(b.doubleTime, 2),
        rate,
        multiplier: rules.doubleTimeMultiplier,
        amount: roundMoney(b.doubleTime * rate * rules.doubleTimeMultiplier),
      });
    }
  };

  if (input.totals) {
    const rate = effectiveRate(baseRate, input.totals.designation, premiums);
    buckets = {
      regular: nonNegative(input.totals.regularHours),
      overtime: nonNegative(input.totals.overtimeHours),
      doubleTime: nonNegative(input.totals.doubleTimeHours),
    };
    gross = grossFromBuckets(buckets, rate, rules);
    pushLines('', buckets, rate);
    effectiveRates.push({ label: 'Effective rate', rate });
    note = 'Entered as period totals — no daily or weekly overtime rule applied.';
  } else {
    const weekInputs = input.weeks ?? [];
    const firstWeek = weekInputs[0];
    if (!firstWeek) {
      return {
        buckets: { ...EMPTY_BUCKETS },
        totalHours: 0,
        lines: [],
        gross: 0,
        estimatedTakeHomeBeforePerDiem: 0,
        perDiemTotal,
        estimatedTakeHome: perDiemTotal,
        deductionPct,
        keepPct: 100 - deductionPct,
        note: 'No hours entered.',
        effectiveRates: [],
      };
    }

    const dailyLabel = rules.dailyThreshold === null ? '' : `${rules.dailyThreshold}/day or `;
    const weeklyLabel = rules.weeklyThreshold === null ? 'no weekly rule' : `${rules.weeklyThreshold}/week`;

    if (input.payPeriod === 'weekly') {
      const rate = effectiveRate(baseRate, firstWeek.designation, premiums);
      buckets = bucketWeek(firstWeek.days, { ...rules, sundayTreatment: firstWeek.sundayTreatment });
      gross = grossFromBuckets(buckets, rate, rules);
      pushLines('', buckets, rate);
      effectiveRates.push({ label: 'Week 1', rate });
      note = `1 week — overtime after ${dailyLabel}${weeklyLabel}.`;
    } else if (input.payPeriod === 'biweekly' && weekInputs.length > 1) {
      const secondWeek = weekInputs[1];
      const rate1 = effectiveRate(baseRate, firstWeek.designation, premiums);
      const rate2 = effectiveRate(baseRate, secondWeek.designation, premiums);
      const b1 = bucketWeek(firstWeek.days, { ...rules, sundayTreatment: firstWeek.sundayTreatment });
      const b2 = bucketWeek(secondWeek.days, { ...rules, sundayTreatment: secondWeek.sundayTreatment });
      buckets = addBuckets(b1, b2);
      gross = grossFromBuckets(b1, rate1, rules) + grossFromBuckets(b2, rate2, rules);
      pushLines('Week 1 ', b1, rate1);
      pushLines('Week 2 ', b2, rate2);
      effectiveRates.push({ label: 'Week 1', rate: rate1 }, { label: 'Week 2', rate: rate2 });
      note = `2 weeks — overtime applied to each week separately, after ${dailyLabel}${weeklyLabel}.`;
    } else {
      // Semi-monthly / monthly: one entered week repeated across the period.
      // Overtime is still evaluated per week, which is what the law requires;
      // the approximation is in the number of weeks, not the rule.
      const rate = effectiveRate(baseRate, firstWeek.designation, premiums);
      const weekly = bucketWeek(firstWeek.days, { ...rules, sundayTreatment: firstWeek.sundayTreatment });
      buckets = scaleBuckets(weekly, weeksCount);
      gross = grossFromBuckets(weekly, rate, rules) * weeksCount;
      pushLines('', buckets, rate);
      effectiveRates.push({ label: 'Effective rate', rate });
      note = `Estimate — the week 1 pattern repeated ${weeksCount.toFixed(2)} times per pay period.`;
    }
  }

  const grossRounded = roundMoney(gross);
  const takeHomeBefore = roundMoney(grossRounded * (1 - deductionPct / 100));

  return {
    buckets,
    totalHours: roundTo(totalHours(buckets), 2),
    lines,
    gross: grossRounded,
    estimatedTakeHomeBeforePerDiem: takeHomeBefore,
    perDiemTotal,
    estimatedTakeHome: roundMoney(takeHomeBefore + perDiemTotal),
    deductionPct,
    keepPct: roundTo(100 - deductionPct, 2),
    note,
    effectiveRates,
  };
}

// ---------------------------------------------------------------------------
// Target → Hours
// ---------------------------------------------------------------------------

export interface TargetToHoursInput {
  /** Desired take-home for the period. */
  targetTakeHome: number;
  baseRate: number;
  payPeriod: PayPeriodKind;
  deductionPct: number;
  designation?: ShiftDesignation;
  premiums?: RatePremiums;
  rules?: OvertimeRules;
  /** Whether hours past the period threshold are paid at the OT multiplier. */
  assumeOvertime: boolean;
  /** Days worked per week, used for the per-day breakdown. */
  daysPerWeek?: number;
  /** Whether the 7th day (Sunday) is paid at double time. */
  sundayDoubleTime?: boolean;
  /** Non-taxed per diem expected in the period; reduces the wages needed. */
  perDiemTotal?: number;
}

export interface TargetToHoursResult {
  /** Gross wages that must be earned to hit the take-home target. */
  grossNeeded: number;
  /** Total hours needed. */
  hours: number;
  buckets: HourBuckets;
  effectiveRate: number;
  note: string;
  /** Hours per worked day, and the shape of the week they sit in. */
  breakdown:
    | { kind: 'grid'; hoursPerDay: number; dayLabels: string[]; weeks: number; daysPerWeek: number }
    | { kind: 'summary'; hoursPerDay: number; totalWorkDays: number; daysPerWeek: number }
    | null;
  /** `false` when the inputs can't produce an answer (no rate, no target). */
  solvable: boolean;
}

const WEEK_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Solves for the hours needed to take home a target amount.
 *
 * The Sunday-double-time case needs its own algebra: one day in seven pays 2×,
 * so the hours cannot simply be divided by a single rate. Two sub-cases are
 * solved and the one whose assumption holds is returned, which is what makes
 * the answer self-consistent rather than approximately right.
 */
export function targetToHours(input: TargetToHoursInput): TargetToHoursResult {
  const rules = input.rules ?? DEFAULT_OVERTIME_RULES;
  const premiums = input.premiums ?? NO_PREMIUMS;
  const deductionPct = clamp(num(input.deductionPct, 0), 0, 100);
  const perDiem = nonNegative(input.perDiemTotal);
  const target = nonNegative(input.targetTakeHome);
  const baseRate = nonNegative(input.baseRate);
  const rate = effectiveRate(baseRate, input.designation ?? 'day', premiums);

  const empty: TargetToHoursResult = {
    grossNeeded: 0,
    hours: 0,
    buckets: { ...EMPTY_BUCKETS },
    effectiveRate: rate,
    note: 'Enter a take-home target and an hourly rate.',
    breakdown: null,
    solvable: false,
  };
  if (target <= 0 || rate <= 0 || deductionPct >= 100) return empty;

  // Per diem arrives untaxed, so it covers part of the target directly.
  const takeHomeFromWages = Math.max(0, target - perDiem);
  const grossNeeded = takeHomeFromWages / (1 - deductionPct / 100);
  if (grossNeeded <= 0) {
    return {
      ...empty,
      grossNeeded: 0,
      solvable: true,
      note: 'Per diem alone already covers this target.',
    };
  }

  const weeks = weeksInPeriod(input.payPeriod);
  const threshold = regularHoursThreshold(input.payPeriod, rules);
  const daysPerWeek = clamp(Math.round(num(input.daysPerWeek, 5)), 1, 7);
  const otMult = rules.overtimeMultiplier;
  const dtMult = rules.doubleTimeMultiplier;

  let hours: number;
  let buckets: HourBuckets;
  let note: string;

  if (daysPerWeek === 7 && input.sundayDoubleTime) {
    // x = hours worked on each of the 7 days. Sunday (1 day/week) pays dtMult;
    // the other 6 follow the straight-time / overtime split.
    const straightOnly = grossNeeded / ((6 + dtMult) * rate * weeks);
    const nonSundayHours = 6 * weeks * straightOnly;

    if (!input.assumeOvertime || nonSundayHours <= threshold) {
      const x = straightOnly;
      hours = 7 * weeks * x;
      buckets = { regular: 6 * weeks * x, overtime: 0, doubleTime: weeks * x };
      note = input.assumeOvertime
        ? `7-day weeks, Sunday at ${dtMult}×, the rest straight time (still under ${threshold.toFixed(0)} hrs).`
        : `7-day weeks, Sunday at ${dtMult}×, the rest straight time.`;
    } else {
      // gross = threshold·rate + (6·weeks·x − threshold)·rate·otMult + weeks·x·rate·dtMult
      const x =
        (grossNeeded + (otMult - 1) * threshold * rate) / ((6 * otMult + dtMult) * rate * weeks);
      const nonSunday = 6 * weeks * x;
      hours = 7 * weeks * x;
      buckets = {
        regular: threshold,
        overtime: Math.max(0, nonSunday - threshold),
        doubleTime: weeks * x,
      };
      note = `7-day weeks, Sunday at ${dtMult}×, the rest at ${otMult}× past ${threshold.toFixed(0)} hrs.`;
    }
  } else if (!input.assumeOvertime) {
    hours = grossNeeded / rate;
    buckets = { regular: hours, overtime: 0, doubleTime: 0 };
    note = 'Straight time on every hour.';
  } else {
    const grossAtThreshold = threshold * rate;
    if (grossNeeded <= grossAtThreshold) {
      hours = grossNeeded / rate;
      buckets = { regular: hours, overtime: 0, doubleTime: 0 };
      note = `Under ${threshold.toFixed(0)} hrs, so straight time throughout.`;
    } else {
      const overtimeHours = (grossNeeded - grossAtThreshold) / (rate * otMult);
      hours = threshold + overtimeHours;
      buckets = { regular: threshold, overtime: overtimeHours, doubleTime: 0 };
      note = `${threshold.toFixed(0)} straight-time hrs, then ${otMult}× on the rest.`;
    }
  }

  const totalWorkDays = daysPerWeek * weeks;
  const hoursPerDay = totalWorkDays > 0 ? hours / totalWorkDays : 0;

  let breakdown: TargetToHoursResult['breakdown'] = null;
  if (totalWorkDays > 0) {
    if (input.payPeriod === 'weekly' || input.payPeriod === 'biweekly') {
      breakdown = {
        kind: 'grid',
        hoursPerDay: roundTo(hoursPerDay, 2),
        dayLabels: WEEK_DAY_LABELS.slice(0, daysPerWeek),
        weeks: input.payPeriod === 'biweekly' ? 2 : 1,
        daysPerWeek,
      };
    } else {
      breakdown = {
        kind: 'summary',
        hoursPerDay: roundTo(hoursPerDay, 2),
        totalWorkDays: roundTo(totalWorkDays, 2),
        daysPerWeek,
      };
    }
  }

  if (rate !== baseRate) {
    note += ` Effective rate $${rate.toFixed(2)}/hr including premiums.`;
  }
  if (perDiem > 0) {
    note += ` $${perDiem.toFixed(2)} of non-taxed per diem was subtracted from the target first.`;
  }

  return {
    grossNeeded: roundMoney(grossNeeded),
    hours: roundTo(hours, 2),
    buckets,
    effectiveRate: rate,
    note,
    breakdown,
    solvable: true,
  };
}

/**
 * Average share of gross withheld across a set of stubs, as a percentage.
 * Returns `null` when no stub carries both a gross and a net figure.
 */
export function averageDeductionPct(
  stubs: readonly { grossPay: number | null; netPay: number | null }[],
): number | null {
  const usable = stubs.filter(
    (s) => s.grossPay !== null && s.netPay !== null && s.grossPay > 0 && s.netPay !== null,
  ) as { grossPay: number; netPay: number }[];
  if (usable.length === 0) return null;
  const total = usable.reduce((sum, s) => sum + (1 - s.netPay / s.grossPay) * 100, 0);
  return roundTo(total / usable.length, 2);
}
