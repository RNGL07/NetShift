/**
 * Feature 3 — "Is This Shift Worth It?"
 *
 * The question people actually ask is not "what does this shift gross?" but
 * "after taxes, gas, food and daycare, what is my hourly rate for giving up a
 * Saturday?" The answer depends on hours *already worked this week*, because
 * the 41st hour is worth 1.5× and the 1st is not.
 */

import { dayIndexMonFirst, isSunday, type IsoDate } from './dates';
import {
  DEFAULT_OVERTIME_RULES,
  grossFromBuckets,
  marginalWeekBuckets,
  effectiveRate,
  NO_PREMIUMS,
  totalHours,
  type HourBuckets,
  type OvertimeRules,
  type RatePremiums,
  type ShiftDesignation,
  type SundayTreatment,
} from './hours';
import { clamp, nonNegative, num, roundMoney, roundTo } from './money';
import { shiftSpan } from './shiftHours';

export interface ShiftCost {
  id: string;
  label: string;
  amount: number;
  /** Recurring costs are Pro; a one-off shift only needs the one-off costs. */
  recurring?: boolean;
}

export interface ShiftValueInput {
  date: IsoDate;
  /** Either explicit hours, or a start/end pair that may cross midnight. */
  hours?: number;
  startTime?: string;
  endTime?: string;
  unpaidBreakMinutes?: number;

  baseRate: number;
  designation: ShiftDesignation;
  premiums?: RatePremiums;
  rules?: OvertimeRules;
  /** How this employer pays Sunday. Applied when the shift date is a Sunday. */
  sundayTreatment?: SundayTreatment;
  /** Holiday premium as a multiplier applied instead of the normal rate. */
  holidayMultiplier?: number | null;

  /** Hours already worked this workweek, Monday first. */
  priorWeekHours: readonly number[];

  /** Estimated withholding on the incremental earnings, as a percentage. */
  marginalDeductionPct: number;

  commuteCost?: number;
  mealCost?: number;
  childcareCost?: number;
  otherCosts?: readonly ShiftCost[];

  /** Non-taxed per diem earned by working this shift. */
  perDiem?: number;
}

export interface ShiftValueResult {
  paidHours: number;
  crossesMidnight: boolean;
  buckets: HourBuckets;
  effectiveRate: number;
  grossIncremental: number;
  estimatedWithholding: number;
  marginalDeductionPct: number;
  perDiem: number;
  totalCosts: number;
  costBreakdown: { label: string; amount: number }[];
  netGain: number;
  /** Net gain ÷ paid hours — the number that answers the actual question. */
  netHourlyRate: number;
  /** Gross ÷ paid hours, for comparison with the headline rate. */
  grossHourlyRate: number;
  workings: { label: string; amount: number; sign: 1 | -1; note?: string }[];
  notes: string[];
  valid: boolean;
}

/**
 * Prices one additional shift on top of the week already worked.
 *
 * `marginalWeekBuckets` is what makes this correct: the shift is added to the
 * real week and the *difference* in buckets is taken, so an 8-hour Saturday
 * after a 40-hour week comes back as 8 overtime hours, not 8 regular ones.
 */
export function evaluateShiftValue(input: ShiftValueInput): ShiftValueResult {
  const rules = input.rules ?? DEFAULT_OVERTIME_RULES;
  const premiums = input.premiums ?? NO_PREMIUMS;

  let paidHours = nonNegative(input.hours);
  let crossesMidnight = false;
  if (input.startTime && input.endTime) {
    const span = shiftSpan({
      start: input.startTime,
      end: input.endTime,
      unpaidBreakMinutes: input.unpaidBreakMinutes,
    });
    if (span) {
      paidHours = span.paidHours;
      crossesMidnight = span.crossesMidnight;
    }
  }

  const notes: string[] = [];
  const invalid: ShiftValueResult = {
    paidHours: 0,
    crossesMidnight: false,
    buckets: { regular: 0, overtime: 0, doubleTime: 0 },
    effectiveRate: 0,
    grossIncremental: 0,
    estimatedWithholding: 0,
    marginalDeductionPct: 0,
    perDiem: 0,
    totalCosts: 0,
    costBreakdown: [],
    netGain: 0,
    netHourlyRate: 0,
    grossHourlyRate: 0,
    workings: [],
    notes: ['Enter the shift length and your hourly rate.'],
    valid: false,
  };

  const baseRate = nonNegative(input.baseRate);
  if (paidHours <= 0 || baseRate <= 0) return invalid;

  const sundayShift = isSunday(input.date);
  const sundayTreatment: SundayTreatment = sundayShift
    ? (input.sundayTreatment ?? rules.sundayTreatment)
    : rules.sundayTreatment;
  const shiftRules: OvertimeRules = { ...rules, sundayTreatment };

  const dayIndex = dayIndexMonFirst(input.date);
  const added = Array.from({ length: 7 }, (_, i) => (i === dayIndex ? paidHours : 0));
  const buckets = marginalWeekBuckets(input.priorWeekHours, added, shiftRules);

  const rate = effectiveRate(baseRate, input.designation, premiums);
  let gross = grossFromBuckets(buckets, rate, shiftRules);

  if (input.holidayMultiplier && input.holidayMultiplier > 0) {
    // A holiday multiplier replaces the normal pricing for the whole shift
    // rather than stacking on top of overtime, which is the common rule and
    // the conservative one.
    gross = paidHours * rate * input.holidayMultiplier;
    notes.push(
      `Priced as a holiday at ${input.holidayMultiplier}× your effective rate, instead of the usual overtime split.`,
    );
  }

  if (sundayShift && sundayTreatment !== 'regular') {
    notes.push(
      sundayTreatment === 'double'
        ? 'Sunday hours are priced at double time, per your pay profile.'
        : 'Sunday hours are priced at the overtime multiplier, per your pay profile.',
    );
  }
  if (crossesMidnight) {
    notes.push(
      'This shift runs past midnight. All of its hours are counted against the day it starts.',
    );
  }
  if (buckets.overtime > 0 && buckets.regular > 0) {
    notes.push(
      `${roundTo(buckets.regular, 2)} of these hours land at straight time and ${roundTo(buckets.overtime, 2)} at ${shiftRules.overtimeMultiplier}×, based on the ${roundTo(
        input.priorWeekHours.reduce((s, h) => s + num(h), 0),
        2,
      )} hours already on this week.`,
    );
  } else if (buckets.overtime > 0 && buckets.regular === 0) {
    notes.push(
      'Every hour of this shift is overtime, because the week is already past the threshold.',
    );
  }

  const deductionPct = clamp(num(input.marginalDeductionPct, 0), 0, 100);
  const withholding = roundMoney(gross * (deductionPct / 100));
  const perDiem = nonNegative(input.perDiem);

  const costBreakdown: { label: string; amount: number }[] = [];
  const pushCost = (label: string, amount: number) => {
    const value = nonNegative(amount);
    if (value > 0) costBreakdown.push({ label, amount: roundMoney(value) });
  };
  pushCost('Commute', input.commuteCost ?? 0);
  pushCost('Meals', input.mealCost ?? 0);
  pushCost('Childcare', input.childcareCost ?? 0);
  for (const cost of input.otherCosts ?? []) {
    pushCost(cost.label || 'Other cost', cost.amount);
  }
  const totalCosts = roundMoney(costBreakdown.reduce((sum, c) => sum + c.amount, 0));

  const grossRounded = roundMoney(gross);
  const netGain = roundMoney(grossRounded - withholding + perDiem - totalCosts);

  const workings: ShiftValueResult['workings'] = [
    {
      label: `${roundTo(totalHours(buckets), 2)} paid hrs at $${rate.toFixed(2)}/hr`,
      amount: grossRounded,
      sign: 1,
      note: 'Incremental gross for this shift only',
    },
    {
      label: `Estimated withholding at ${deductionPct.toFixed(1)}%`,
      amount: withholding,
      sign: -1,
      note: 'An estimate, not a guaranteed tax figure',
    },
  ];
  if (perDiem > 0) {
    workings.push({ label: 'Per diem (not taxed)', amount: roundMoney(perDiem), sign: 1 });
  }
  for (const cost of costBreakdown) {
    workings.push({ label: cost.label, amount: cost.amount, sign: -1 });
  }

  return {
    paidHours: roundTo(paidHours, 2),
    crossesMidnight,
    buckets,
    effectiveRate: roundTo(rate, 4),
    grossIncremental: grossRounded,
    estimatedWithholding: withholding,
    marginalDeductionPct: deductionPct,
    perDiem: roundMoney(perDiem),
    totalCosts,
    costBreakdown,
    netGain,
    netHourlyRate: roundMoney(netGain / paidHours),
    grossHourlyRate: roundMoney(grossRounded / paidHours),
    workings,
    notes,
    valid: true,
  };
}

/** How a shift's net gain moves a goal or a debt along. */
export function shiftImpact(
  netGain: number,
  target: { kind: 'goal' | 'debt'; name: string; remaining: number } | null,
): { message: string; pctOfRemaining: number } | null {
  if (!target || target.remaining <= 0 || netGain <= 0) return null;
  const pct = roundTo((netGain / target.remaining) * 100, 2);
  const shiftsNeeded = Math.ceil(target.remaining / netGain);
  return {
    pctOfRemaining: pct,
    message:
      target.kind === 'goal'
        ? `This shift covers ${pct.toFixed(1)}% of what is left on “${target.name}” — about ${shiftsNeeded} more ${shiftsNeeded === 1 ? 'shift' : 'shifts'} like it.`
        : `Put toward “${target.name}”, this shift covers ${pct.toFixed(1)}% of the balance — about ${shiftsNeeded} more ${shiftsNeeded === 1 ? 'shift' : 'shifts'} like it, before interest.`,
  };
}
