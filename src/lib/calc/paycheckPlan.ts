/**
 * Feature 2 — Paycheck Plan.
 *
 * Shift workers are paid every other Friday and their bills are not. Planning
 * "by the month" leaves a three-paycheck month looking rich and the rent
 * looking unaffordable. Everything here is payday-to-payday: a plan covers the
 * window `[payday, nextPayday)`, and a bill belongs to exactly one window.
 */

import {
  addDays,
  daysBetween,
  isWithin,
  nextPayday,
  type IsoDate,
  type PayFrequency,
} from './dates';
import { nonNegative, roundMoney } from './money';

export type BillCadence = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

export interface Bill {
  id: string;
  name: string;
  amount: number;
  /** First (or only) due date. */
  dueDate: IsoDate;
  cadence: BillCadence;
  /** Optional last date the bill recurs. */
  endDate?: IsoDate | null;
  essential: boolean;
  /** Bills the user has already paid out of a previous paycheck. */
  paid?: boolean;
}

export interface BillOccurrence {
  billId: string;
  name: string;
  amount: number;
  dueDate: IsoDate;
  essential: boolean;
}

/**
 * Expands a recurring bill into the occurrences that fall in `[start, end)`.
 *
 * The window is half-open on purpose: a bill due exactly on the next payday
 * belongs to the *next* plan, not this one. That is the rule that stops a bill
 * being counted twice when two consecutive plans are open side by side.
 */
export function billOccurrencesInWindow(
  bill: Bill,
  start: IsoDate,
  end: IsoDate,
): BillOccurrence[] {
  const out: BillOccurrence[] = [];
  const amount = nonNegative(bill.amount);
  if (amount <= 0) return out;

  const push = (dueDate: IsoDate) => {
    out.push({ billId: bill.id, name: bill.name, amount, dueDate, essential: bill.essential });
  };

  // Half-open window: due >= start and due < end.
  const inWindow = (date: IsoDate) => daysBetween(start, date) >= 0 && daysBetween(date, end) > 0;

  if (bill.cadence === 'once') {
    if (inWindow(bill.dueDate)) push(bill.dueDate);
    return out;
  }

  const stepDays: Record<Exclude<BillCadence, 'once'>, number> = {
    weekly: 7,
    biweekly: 14,
    monthly: 0, // handled by month arithmetic below
    quarterly: 0,
    annual: 0,
  };

  const monthStep: Partial<Record<BillCadence, number>> = {
    monthly: 1,
    quarterly: 3,
    annual: 12,
  };

  let cursor = bill.dueDate;
  let guard = 0;
  const maxIterations = 600;

  // Fast-forward to the window rather than iterating from an old start date.
  while (daysBetween(cursor, start) > 0 && guard++ < maxIterations) {
    cursor = advance(cursor, bill.cadence, stepDays, monthStep);
  }

  guard = 0;
  while (inWindow(cursor) && guard++ < maxIterations) {
    if (bill.endDate && daysBetween(bill.endDate, cursor) > 0) break;
    push(cursor);
    cursor = advance(cursor, bill.cadence, stepDays, monthStep);
  }

  return out;
}

function advance(
  date: IsoDate,
  cadence: BillCadence,
  stepDays: Record<string, number>,
  monthStep: Partial<Record<BillCadence, number>>,
): IsoDate {
  const months = monthStep[cadence];
  if (months) {
    // Local import avoids a cycle; addMonths clamps end-of-month correctly.
    return addMonthsLocal(date, months);
  }
  return addDays(date, stepDays[cadence] || 30);
}

function addMonthsLocal(date: IsoDate, months: number): IsoDate {
  // Re-implemented here rather than imported to keep this module's dependency
  // surface to the two date helpers it genuinely needs.
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastDay));
  const yy = target.getFullYear();
  const mm = String(target.getMonth() + 1).padStart(2, '0');
  const dd = String(target.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export interface PaycheckPlanInput {
  payPeriodStart: IsoDate;
  payPeriodEnd: IsoDate;
  payday: IsoDate;
  frequency: PayFrequency;
  /** Optional explicit next payday; otherwise derived from `frequency`. */
  nextPaydayOverride?: IsoDate | null;
  expectedGross: number;
  /** Estimated deductions in dollars. Takes precedence over the percentage. */
  expectedDeductions?: number | null;
  /** Fallback when no dollar figure is known. */
  deductionPct?: number;
  /** Non-taxed per diem expected on this check. */
  perDiem?: number;
  /** Money already in the account when the paycheck lands. */
  startingAvailableBalance: number;
  bills: readonly Bill[];
  plannedSavings: number;
  plannedDebtPayments: number;
  safetyBuffer: number;
  /**
   * Amounts already counted elsewhere — e.g. a bill the user marked paid from
   * the previous check. Subtracted from the bill total, never added twice.
   */
  excludedBillIds?: readonly string[];
}

export interface PaycheckPlanResult {
  payday: IsoDate;
  nextPayday: IsoDate;
  daysCovered: number;
  expectedGross: number;
  expectedDeductions: number;
  expectedTakeHome: number;
  perDiem: number;
  startingAvailableBalance: number;
  bills: BillOccurrence[];
  billsDue: number;
  essentialBillsDue: number;
  plannedSavings: number;
  plannedDebtPayments: number;
  safetyBuffer: number;
  safeToSpend: number;
  safeToSpendPerDay: number;
  /** Balance projected for the day before the next paycheck lands. */
  projectedEndingBalance: number;
  /** Ordered arithmetic the UI renders so the number is never unexplained. */
  workings: { label: string; amount: number; sign: 1 | -1 }[];
  /** How confident the take-home figure is, and why. */
  confidence: {
    level: 'estimated' | 'confirmed';
    lowTakeHome: number;
    highTakeHome: number;
    explanation: string;
  };
  warnings: string[];
}

/**
 * The core plan calculation.
 *
 *   safe_to_spend = starting_balance + take_home − bills − savings − debt − buffer
 *
 * Double-counting is prevented structurally: bill occurrences are derived
 * fresh from the bill list for this window only, deduplicated by
 * `billId + dueDate`, and anything the caller marks excluded is dropped before
 * the total is taken. Nothing is accumulated across calls.
 */
export function buildPaycheckPlan(input: PaycheckPlanInput): PaycheckPlanResult {
  const payday = input.payday;
  const next = input.nextPaydayOverride || nextPayday(payday, input.frequency);
  const daysCovered = Math.max(1, daysBetween(payday, next));

  const gross = nonNegative(input.expectedGross);
  const perDiem = nonNegative(input.perDiem);

  const deductions =
    input.expectedDeductions !== null && input.expectedDeductions !== undefined
      ? nonNegative(input.expectedDeductions)
      : roundMoney(gross * (Math.min(100, Math.max(0, input.deductionPct ?? 0)) / 100));

  const takeHome = roundMoney(Math.max(0, gross - deductions) + perDiem);

  const excluded = new Set(input.excludedBillIds ?? []);
  const seen = new Set<string>();
  const bills: BillOccurrence[] = [];
  for (const bill of input.bills) {
    if (excluded.has(bill.id) || bill.paid) continue;
    for (const occurrence of billOccurrencesInWindow(bill, payday, next)) {
      const key = `${occurrence.billId}:${occurrence.dueDate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bills.push(occurrence);
    }
  }
  // Earliest due date first, so the UI lists bills in the order they hit.
  bills.sort((a, b) => daysBetween(b.dueDate, a.dueDate));

  const billsDue = roundMoney(bills.reduce((sum, b) => sum + b.amount, 0));
  const essentialBillsDue = roundMoney(
    bills.filter((b) => b.essential).reduce((sum, b) => sum + b.amount, 0),
  );

  const startingBalance = roundMoney(input.startingAvailableBalance);
  const savings = nonNegative(input.plannedSavings);
  const debt = nonNegative(input.plannedDebtPayments);
  const buffer = nonNegative(input.safetyBuffer);

  const safeToSpend = roundMoney(startingBalance + takeHome - billsDue - savings - debt - buffer);
  const projectedEndingBalance = roundMoney(safeToSpend + buffer);

  const workings: PaycheckPlanResult['workings'] = [
    { label: 'Starting balance', amount: startingBalance, sign: 1 },
    { label: 'Expected take-home', amount: takeHome, sign: 1 },
    { label: 'Bills due before next payday', amount: billsDue, sign: -1 },
    { label: 'Planned savings', amount: savings, sign: -1 },
    { label: 'Planned debt payments', amount: debt, sign: -1 },
    { label: 'Safety buffer', amount: buffer, sign: -1 },
  ];

  const warnings: string[] = [];
  if (safeToSpend < 0) {
    warnings.push(
      `This plan is short by ${Math.abs(safeToSpend).toFixed(2)} before any discretionary spending. Lowering the safety buffer or moving a non-essential bill are the usual levers.`,
    );
  }
  if (billsDue > takeHome && startingBalance <= 0) {
    warnings.push('Bills in this window exceed this paycheck on their own.');
  }
  if (daysBetween(input.payPeriodEnd, payday) < 0) {
    warnings.push(
      'The payday is before the end of the pay period it covers. Double-check the dates.',
    );
  }
  const outsideWindow = input.bills.filter(
    (b) => b.cadence === 'once' && !excluded.has(b.id) && !isWithin(b.dueDate, payday, next),
  ).length;
  if (outsideWindow > 0) {
    warnings.push(
      `${outsideWindow} one-off ${outsideWindow === 1 ? 'bill falls' : 'bills fall'} outside this payday window and ${outsideWindow === 1 ? 'is' : 'are'} planned against another paycheck.`,
    );
  }

  // The range reflects how variable the *income* side is, which is the part a
  // shift worker cannot pin down until the check lands.
  const isConfirmed = input.expectedDeductions !== null && input.expectedDeductions !== undefined;
  const swing = isConfirmed ? 0 : takeHome * 0.08;

  return {
    payday,
    nextPayday: next,
    daysCovered,
    expectedGross: roundMoney(gross),
    expectedDeductions: roundMoney(deductions),
    expectedTakeHome: takeHome,
    perDiem: roundMoney(perDiem),
    startingAvailableBalance: startingBalance,
    bills,
    billsDue,
    essentialBillsDue,
    plannedSavings: roundMoney(savings),
    plannedDebtPayments: roundMoney(debt),
    safetyBuffer: roundMoney(buffer),
    safeToSpend,
    safeToSpendPerDay: roundMoney(safeToSpend / daysCovered),
    projectedEndingBalance,
    workings,
    confidence: {
      level: isConfirmed ? 'confirmed' : 'estimated',
      lowTakeHome: roundMoney(takeHome - swing),
      highTakeHome: roundMoney(takeHome + swing),
      explanation: isConfirmed
        ? 'Take-home comes from deduction amounts you entered, so this plan uses confirmed figures.'
        : 'Take-home is estimated from your average deduction rate. Actual withholding varies with overtime, benefits, and year-to-date totals.',
    },
    warnings,
  };
}

/**
 * Builds consecutive plans from one starting payday, carrying each plan's
 * projected ending balance into the next as its starting balance.
 *
 * The carry is the only coupling between plans; bills are never carried, so a
 * bill can never appear in two windows.
 */
export function buildPlanSeries(
  base: Omit<PaycheckPlanInput, 'payday' | 'payPeriodStart' | 'payPeriodEnd'>,
  firstPayday: IsoDate,
  periods: number,
  periodDates: (payday: IsoDate) => { start: IsoDate; end: IsoDate },
): PaycheckPlanResult[] {
  const out: PaycheckPlanResult[] = [];
  let payday = firstPayday;
  let startingBalance = base.startingAvailableBalance;

  for (let i = 0; i < Math.max(0, periods); i++) {
    const { start, end } = periodDates(payday);
    const plan = buildPaycheckPlan({
      ...base,
      payday,
      payPeriodStart: start,
      payPeriodEnd: end,
      startingAvailableBalance: startingBalance,
      nextPaydayOverride: null,
    });
    out.push(plan);
    // Carry what is left after the buffer is released back into spendable cash.
    startingBalance = plan.projectedEndingBalance;
    payday = plan.nextPayday;
  }

  return out;
}
