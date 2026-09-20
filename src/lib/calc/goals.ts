/**
 * Feature 4 — Goal Funding From Overtime.
 *
 * Translates "I need $4,000 for a down payment by June" into the thing a shift
 * worker can actually act on: how many overtime hours that is, and whether the
 * date is reachable at all.
 */

import { addDays, daysBetween, todayIso, type IsoDate, type PayFrequency } from './dates';
import { daysPerPayPeriod } from './dates';
import { DEFAULT_OVERTIME_RULES, type OvertimeRules } from './hours';
import { clamp, nonNegative, num, roundMoney, roundTo } from './money';

export type GoalType =
  | 'emergency_fund'
  | 'debt'
  | 'vacation'
  | 'down_payment'
  | 'vehicle_repair'
  | 'retirement_contribution'
  | 'custom';

export const GOAL_TYPE_LABELS: Record<GoalType, string> = {
  emergency_fund: 'Emergency fund',
  debt: 'Debt payoff',
  vacation: 'Vacation',
  down_payment: 'Down payment',
  vehicle_repair: 'Vehicle repair',
  retirement_contribution: 'Retirement contribution',
  custom: 'Custom goal',
};

export interface GoalInput {
  targetAmount: number;
  currentAmount: number;
  targetDate?: IsoDate | null;
  /** Amount the user already plans to put in from each paycheck. */
  perPaycheckContribution?: number;
  frequency: PayFrequency;
  baseRate: number;
  /** Effective rate including premiums — what an extra hour really pays. */
  effectiveRate?: number;
  /** Estimated withholding on incremental earnings, percent. */
  marginalDeductionPct: number;
  rules?: OvertimeRules;
  /** Today, injectable so tests are not clock-dependent. */
  today?: IsoDate;
}

export interface GoalFundingResult {
  targetAmount: number;
  currentAmount: number;
  remaining: number;
  progressPct: number;
  complete: boolean;

  /** Per-paycheck contribution needed to hit `targetDate`, if one is set. */
  requiredPerPaycheck: number | null;
  paychecksUntilTarget: number | null;

  /** Gross earnings that must be generated to net `requiredPerPaycheck`. */
  grossNeededPerPaycheck: number | null;
  hoursNeeded: {
    regular: number | null;
    overtime: number | null;
    doubleTime: number | null;
  };

  /** Completion date at the user's current planned contribution. */
  projectedCompletionDate: IsoDate | null;
  paychecksAtCurrentRate: number | null;

  /** What one extra 8-hour overtime shift does to the timeline. */
  extraShiftEffect: {
    netPerShift: number;
    weeksSavedWithOneShiftPerWeek: number | null;
    completionWithOneShiftPerWeek: IsoDate | null;
    completionWithOneShiftPerMonth: IsoDate | null;
  } | null;

  notes: string[];
  /** `true` when the target date cannot be met by any realistic hours. */
  targetDateUnreachable: boolean;
}

const MAX_WEEKLY_HOURS = 84; // 12 hours × 7 days, the practical ceiling.

/**
 * Works a goal backwards into hours.
 *
 * Tax treatment is deliberately labelled an estimate everywhere it appears:
 * marginal withholding on overtime is genuinely unpredictable (it depends on
 * YTD totals, benefit elections, and supplemental-wage rules), and presenting
 * it as settled would be the most misleading thing this module could do.
 */
export function calculateGoalFunding(input: GoalInput): GoalFundingResult {
  const rules = input.rules ?? DEFAULT_OVERTIME_RULES;
  const today = input.today ?? todayIso();
  const target = nonNegative(input.targetAmount);
  const current = nonNegative(input.currentAmount);
  const remaining = roundMoney(Math.max(0, target - current));
  const progressPct = target > 0 ? clamp(roundTo((current / target) * 100, 2), 0, 100) : 0;
  const complete = remaining <= 0 && target > 0;

  const rate = nonNegative(input.effectiveRate ?? input.baseRate);
  const deductionPct = clamp(num(input.marginalDeductionPct, 0), 0, 100);
  const keepShare = 1 - deductionPct / 100;

  const notes: string[] = [];
  if (deductionPct > 0) {
    notes.push(
      `Hour figures assume ${deductionPct.toFixed(1)}% of extra gross goes to withholding. That is an estimate from your own paycheck history, not a guaranteed tax rate — overtime is often withheld at a higher rate than regular pay.`,
    );
  }

  const periodDays = daysPerPayPeriod(input.frequency);

  let requiredPerPaycheck: number | null = null;
  let paychecksUntilTarget: number | null = null;
  let targetDateUnreachable = false;

  if (input.targetDate) {
    const days = daysBetween(today, input.targetDate);
    if (days <= 0) {
      notes.push('The target date has passed. Pick a new one to see what it would take.');
      targetDateUnreachable = remaining > 0;
    } else {
      paychecksUntilTarget = Math.max(1, Math.floor(days / periodDays));
      requiredPerPaycheck = roundMoney(remaining / paychecksUntilTarget);
    }
  }

  let grossNeededPerPaycheck: number | null = null;
  const hoursNeeded: GoalFundingResult['hoursNeeded'] = {
    regular: null,
    overtime: null,
    doubleTime: null,
  };

  if (requiredPerPaycheck !== null && rate > 0 && keepShare > 0) {
    grossNeededPerPaycheck = roundMoney(requiredPerPaycheck / keepShare);
    hoursNeeded.regular = roundTo(grossNeededPerPaycheck / rate, 2);
    hoursNeeded.overtime = roundTo(grossNeededPerPaycheck / (rate * rules.overtimeMultiplier), 2);
    hoursNeeded.doubleTime = roundTo(
      grossNeededPerPaycheck / (rate * rules.doubleTimeMultiplier),
      2,
    );

    const weeksPerPeriod = periodDays / 7;
    const overtimeHoursPerWeek = hoursNeeded.overtime / weeksPerPeriod;
    if (overtimeHoursPerWeek > MAX_WEEKLY_HOURS - (rules.weeklyThreshold ?? 40)) {
      targetDateUnreachable = true;
      notes.push(
        `Hitting this by ${input.targetDate} would take roughly ${overtimeHoursPerWeek.toFixed(1)} overtime hours every week, which is beyond what a normal schedule allows. Consider a later date or a smaller target.`,
      );
    }
  }

  let projectedCompletionDate: IsoDate | null = null;
  let paychecksAtCurrentRate: number | null = null;
  const planned = nonNegative(input.perPaycheckContribution);
  if (planned > 0 && remaining > 0) {
    paychecksAtCurrentRate = Math.ceil(remaining / planned);
    projectedCompletionDate = addDays(today, paychecksAtCurrentRate * periodDays);
  } else if (remaining > 0) {
    notes.push('Set a per-paycheck contribution to see a projected completion date.');
  }

  let extraShiftEffect: GoalFundingResult['extraShiftEffect'] = null;
  if (rate > 0 && remaining > 0) {
    const shiftHours = 8;
    const netPerShift = roundMoney(shiftHours * rate * rules.overtimeMultiplier * keepShare);
    if (netPerShift > 0) {
      const weeksWithOnePerWeek = Math.ceil(remaining / netPerShift);
      const monthsWithOnePerMonth = Math.ceil(remaining / netPerShift);
      const baselineWeeks =
        paychecksAtCurrentRate !== null ? (paychecksAtCurrentRate * periodDays) / 7 : null;
      extraShiftEffect = {
        netPerShift,
        weeksSavedWithOneShiftPerWeek:
          baselineWeeks !== null
            ? roundTo(
                Math.max(0, baselineWeeks - remaining / (planned / (periodDays / 7) + netPerShift)),
                1,
              )
            : null,
        completionWithOneShiftPerWeek: addDays(today, weeksWithOnePerWeek * 7),
        completionWithOneShiftPerMonth: addDays(today, monthsWithOnePerMonth * 30),
      };
    }
  }

  if (complete) {
    notes.unshift('This goal is funded.');
  }

  return {
    targetAmount: roundMoney(target),
    currentAmount: roundMoney(current),
    remaining,
    progressPct,
    complete,
    requiredPerPaycheck,
    paychecksUntilTarget,
    grossNeededPerPaycheck,
    hoursNeeded,
    projectedCompletionDate,
    paychecksAtCurrentRate,
    extraShiftEffect,
    notes,
    targetDateUnreachable,
  };
}

export interface GoalContribution {
  amount: number;
  contributedOn: IsoDate;
}

/** Sums logged contributions — the authoritative progress figure. */
export function totalContributed(contributions: readonly GoalContribution[]): number {
  return roundMoney(contributions.reduce((sum, c) => sum + num(c.amount), 0));
}

/**
 * Splits a lump sum across goals by priority order, filling each goal's
 * remaining need before moving to the next.
 */
export function allocateToGoals(
  amount: number,
  goals: readonly { id: string; name: string; remaining: number }[],
): { goalId: string; name: string; amount: number }[] {
  let left = nonNegative(amount);
  const out: { goalId: string; name: string; amount: number }[] = [];
  for (const goal of goals) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, goal.remaining));
    if (take <= 0) continue;
    out.push({ goalId: goal.id, name: goal.name, amount: roundMoney(take) });
    left -= take;
  }
  return out;
}
