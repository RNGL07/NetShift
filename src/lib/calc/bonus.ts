/**
 * Feature 8 — Bonus and profit-sharing planner.
 *
 * Annual profit sharing is the single largest cheque many manufacturing
 * workers see all year, it arrives withheld at supplemental-wage rates, and it
 * is usually spent before it lands. This models the three-point estimate and
 * then holds the allocation to what actually exists.
 */

import { nonNegative, num, roundMoney, roundTo } from './money';
import type { IsoDate } from './dates';

export type BonusKind = 'profit_sharing' | 'annual_bonus' | 'referral' | 'retention' | 'other';

export const BONUS_KIND_LABELS: Record<BonusKind, string> = {
  profit_sharing: 'Profit sharing',
  annual_bonus: 'Annual bonus',
  referral: 'Referral bonus',
  retention: 'Retention bonus',
  other: 'Other',
};

export type AllocationTarget = 'debt' | 'savings' | 'investment' | 'goal' | 'discretionary';

export const ALLOCATION_TARGET_LABELS: Record<AllocationTarget, string> = {
  debt: 'Debt payoff',
  savings: 'Savings / buffer',
  investment: 'Investing',
  goal: 'A goal',
  discretionary: 'Spending',
};

export interface BonusAllocation {
  id: string;
  target: AllocationTarget;
  label: string;
  /** Either a percentage of the net bonus, or a fixed amount. Not both. */
  percent?: number | null;
  amount?: number | null;
  /** Optional link to a goal or debt record. */
  linkedId?: string | null;
}

export interface BonusInput {
  name: string;
  kind: BonusKind;
  expectedDate: IsoDate | null;
  conservativeGross: number;
  baseGross: number;
  optimisticGross: number;
  /**
   * Estimated withholding rate on the bonus, percent. Supplemental wages are
   * commonly withheld at a flat federal rate plus payroll taxes, which is why
   * this defaults high rather than to the user's normal paycheck rate.
   */
  withholdingPct: number;
  allocations: readonly BonusAllocation[];
  /** Which scenario the allocations are measured against. */
  allocateAgainst?: 'conservative' | 'base' | 'optimistic' | 'actual';
  actualGross?: number | null;
  actualNet?: number | null;
}

export interface BonusScenario {
  label: string;
  gross: number;
  withholding: number;
  net: number;
}

export interface ResolvedAllocation {
  id: string;
  target: AllocationTarget;
  label: string;
  linkedId: string | null;
  /** Dollars this allocation claims. */
  amount: number;
  /** Share of the allocatable net, as a percentage. */
  percentOfNet: number;
  /** `true` when the request had to be trimmed to fit what is left. */
  trimmed: boolean;
}

export interface BonusPlanResult {
  scenarios: { conservative: BonusScenario; base: BonusScenario; optimistic: BonusScenario };
  actual: BonusScenario | null;
  /** The net figure the allocations are measured against. */
  allocatableNet: number;
  allocatedAgainst: string;
  allocations: ResolvedAllocation[];
  totalAllocated: number;
  unallocated: number;
  /** `true` when the requested allocations exceeded what is available. */
  overAllocated: boolean;
  overAllocatedBy: number;
  byTarget: { target: AllocationTarget; label: string; amount: number; percent: number }[];
  variance: {
    grossVsBase: number | null;
    netVsExpected: number | null;
    message: string;
  } | null;
  warnings: string[];
}

function scenario(label: string, gross: number, withholdingPct: number): BonusScenario {
  const g = nonNegative(gross);
  const withholding = roundMoney(g * (Math.min(100, Math.max(0, withholdingPct)) / 100));
  return { label, gross: roundMoney(g), withholding, net: roundMoney(g - withholding) };
}

/**
 * Builds the three-point plan and resolves allocations against it.
 *
 * Allocations are resolved in order and *clamped to what remains*, so the plan
 * can never distribute more money than the bonus produces. A trimmed
 * allocation is marked rather than silently shrunk.
 */
export function planBonus(input: BonusInput): BonusPlanResult {
  const withholdingPct = Math.min(100, Math.max(0, num(input.withholdingPct, 0)));
  const warnings: string[] = [];

  const conservative = scenario('Conservative', input.conservativeGross, withholdingPct);
  const base = scenario('Base', input.baseGross, withholdingPct);
  const optimistic = scenario('Optimistic', input.optimisticGross, withholdingPct);

  if (conservative.gross > base.gross || base.gross > optimistic.gross) {
    warnings.push(
      'The conservative, base, and optimistic estimates are not in ascending order. Check the figures.',
    );
  }

  let actual: BonusScenario | null = null;
  if (input.actualGross !== null && input.actualGross !== undefined) {
    const gross = nonNegative(input.actualGross);
    const net =
      input.actualNet !== null && input.actualNet !== undefined
        ? nonNegative(input.actualNet)
        : roundMoney(gross * (1 - withholdingPct / 100));
    actual = {
      label: 'Actual',
      gross: roundMoney(gross),
      withholding: roundMoney(gross - net),
      net: roundMoney(net),
    };
  }

  const against = input.allocateAgainst ?? 'conservative';
  const source =
    against === 'actual' && actual
      ? actual
      : against === 'optimistic'
        ? optimistic
        : against === 'base'
          ? base
          : conservative;

  const allocatableNet = source.net;

  let remaining = allocatableNet;
  let requestedTotal = 0;
  const resolved: ResolvedAllocation[] = [];

  for (const allocation of input.allocations) {
    const requested =
      allocation.amount !== null && allocation.amount !== undefined
        ? nonNegative(allocation.amount)
        : roundMoney(allocatableNet * (Math.max(0, num(allocation.percent, 0)) / 100));
    requestedTotal = roundMoney(requestedTotal + requested);

    const granted = roundMoney(Math.min(requested, Math.max(0, remaining)));
    remaining = roundMoney(remaining - granted);

    resolved.push({
      id: allocation.id,
      target: allocation.target,
      label: allocation.label || ALLOCATION_TARGET_LABELS[allocation.target],
      linkedId: allocation.linkedId ?? null,
      amount: granted,
      percentOfNet: allocatableNet > 0 ? roundTo((granted / allocatableNet) * 100, 2) : 0,
      trimmed: granted < requested - 0.005,
    });
  }

  const totalAllocated = roundMoney(resolved.reduce((sum, a) => sum + a.amount, 0));
  const overAllocatedBy = roundMoney(Math.max(0, requestedTotal - allocatableNet));
  const overAllocated = overAllocatedBy > 0.005;

  if (overAllocated) {
    warnings.push(
      `These allocations add up to ${requestedTotal.toFixed(2)}, which is ${overAllocatedBy.toFixed(2)} more than the ${source.label.toLowerCase()} estimate leaves after withholding. The last ${resolved.filter((a) => a.trimmed).length} have been trimmed to fit.`,
    );
  }

  const byTargetMap = new Map<AllocationTarget, number>();
  for (const allocation of resolved) {
    byTargetMap.set(
      allocation.target,
      roundMoney((byTargetMap.get(allocation.target) ?? 0) + allocation.amount),
    );
  }
  const byTarget = [...byTargetMap.entries()]
    .map(([target, amount]) => ({
      target,
      label: ALLOCATION_TARGET_LABELS[target],
      amount,
      percent: allocatableNet > 0 ? roundTo((amount / allocatableNet) * 100, 2) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  let variance: BonusPlanResult['variance'] = null;
  if (actual) {
    const grossVsBase = roundMoney(actual.gross - base.gross);
    const netVsExpected = roundMoney(actual.net - source.net);
    variance = {
      grossVsBase,
      netVsExpected,
      message:
        grossVsBase >= 0
          ? `The actual bonus came in ${grossVsBase.toFixed(2)} above your base estimate.`
          : `The actual bonus came in ${Math.abs(grossVsBase).toFixed(2)} below your base estimate.`,
    };
    if (Math.abs(actual.withholding / Math.max(1, actual.gross) - withholdingPct / 100) > 0.05) {
      warnings.push(
        `Actual withholding on this bonus was ${((actual.withholding / Math.max(1, actual.gross)) * 100).toFixed(1)}%, not the ${withholdingPct.toFixed(1)}% you estimated. Updating the estimate will make the next plan closer.`,
      );
    }
  }

  if (withholdingPct < 20 && source.gross > 0) {
    warnings.push(
      'Bonuses and profit sharing are often withheld at a higher rate than regular pay. A withholding estimate under 20% may leave the net figure optimistic.',
    );
  }

  return {
    scenarios: { conservative, base, optimistic },
    actual,
    allocatableNet,
    allocatedAgainst: source.label,
    allocations: resolved,
    totalAllocated,
    unallocated: roundMoney(Math.max(0, allocatableNet - totalAllocated)),
    overAllocated,
    overAllocatedBy,
    byTarget,
    variance,
    warnings,
  };
}

/**
 * Validates an allocation set before it is saved.
 *
 * Returns the problems rather than throwing, so the form can show them all at
 * once next to the fields they belong to.
 */
export function validateAllocations(
  allocations: readonly BonusAllocation[],
  allocatableNet: number,
): { valid: boolean; errors: { id: string; message: string }[]; totalRequested: number } {
  const errors: { id: string; message: string }[] = [];
  let totalRequested = 0;
  let totalPercent = 0;

  for (const allocation of allocations) {
    const hasPercent = allocation.percent !== null && allocation.percent !== undefined;
    const hasAmount = allocation.amount !== null && allocation.amount !== undefined;

    if (hasPercent && hasAmount) {
      errors.push({
        id: allocation.id,
        message: 'Set either a percentage or a dollar amount, not both.',
      });
    }
    if (!hasPercent && !hasAmount) {
      errors.push({ id: allocation.id, message: 'Enter a percentage or a dollar amount.' });
    }
    if (hasPercent) {
      const pct = num(allocation.percent, 0);
      if (pct < 0 || pct > 100) {
        errors.push({ id: allocation.id, message: 'Percentage must be between 0 and 100.' });
      }
      totalPercent += pct;
      totalRequested = roundMoney(totalRequested + allocatableNet * (pct / 100));
    }
    if (hasAmount) {
      const amount = num(allocation.amount, 0);
      if (amount < 0) {
        errors.push({ id: allocation.id, message: 'Amount cannot be negative.' });
      }
      totalRequested = roundMoney(totalRequested + amount);
    }
  }

  if (totalPercent > 100.001) {
    errors.push({
      id: '__total__',
      message: `Percentages add up to ${totalPercent.toFixed(1)}%, which is more than the whole bonus.`,
    });
  }
  if (totalRequested > allocatableNet + 0.005) {
    errors.push({
      id: '__total__',
      message: `Allocations total ${totalRequested.toFixed(2)}, which is more than the ${allocatableNet.toFixed(2)} this bonus is expected to net.`,
    });
  }

  return { valid: errors.length === 0, errors, totalRequested };
}
