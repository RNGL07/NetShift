/**
 * Feature 6 — Debt payoff with shift and overtime scenarios.
 *
 * Amortisation is the one place in this app where a sloppy loop produces
 * confidently wrong output: a payment that does not cover accrued interest
 * makes the balance *grow*, and a naive `while (balance > 0)` then never
 * terminates. Every path here is bounded and every non-amortising case is
 * detected and reported rather than iterated into.
 */

import { addMonths, todayIso, type IsoDate } from './dates';
import { nonNegative, num, roundMoney } from './money';

export type DebtKind =
  'credit_card' | 'auto' | 'student' | 'personal' | 'mortgage' | 'medical' | 'other';

export const DEBT_KIND_LABELS: Record<DebtKind, string> = {
  credit_card: 'Credit card',
  auto: 'Auto loan',
  student: 'Student loan',
  personal: 'Personal loan',
  mortgage: 'Mortgage',
  medical: 'Medical',
  other: 'Other',
};

export interface Debt {
  id: string;
  name: string;
  kind: DebtKind;
  balance: number;
  /** Annual percentage rate, e.g. 22.99. */
  apr: number;
  minimumPayment: number;
  /** Optional promotional APR that applies until `promoEndDate`. */
  promoApr?: number | null;
  promoEndDate?: IsoDate | null;
}

export type PayoffStrategy = 'snowball' | 'avalanche' | 'as_entered';

export interface AmortizationMonth {
  monthIndex: number;
  date: IsoDate;
  startingBalance: number;
  interest: number;
  principal: number;
  payment: number;
  endingBalance: number;
}

export interface DebtPayoffResult {
  debtId: string;
  name: string;
  /** `false` when the payment never clears the balance. */
  amortizes: boolean;
  monthsToPayoff: number | null;
  payoffDate: IsoDate | null;
  totalInterest: number;
  totalPaid: number;
  schedule: AmortizationMonth[];
  warnings: string[];
}

export const MAX_AMORTIZATION_MONTHS = 600; // 50 years — past this, say so instead.

function monthlyRate(apr: number): number {
  return Math.max(0, num(apr, 0)) / 100 / 12;
}

/** The APR in force in a given month, honouring a promotional rate window. */
function rateForMonth(debt: Debt, date: IsoDate): number {
  if (debt.promoApr !== null && debt.promoApr !== undefined && debt.promoEndDate) {
    // Promo applies while the month's date is on or before the promo end date.
    if (date <= debt.promoEndDate) return monthlyRate(debt.promoApr);
  }
  return monthlyRate(debt.apr);
}

/**
 * Amortises a single debt at a fixed monthly payment.
 *
 * When the payment is at or below the first month's interest the loan never
 * amortises; that is reported as `amortizes: false` with an explanatory
 * warning rather than looped until the iteration cap.
 */
export function amortizeDebt(
  debt: Debt,
  monthlyPayment: number,
  options: { startDate?: IsoDate; maxMonths?: number; extraOneTime?: number } = {},
): DebtPayoffResult {
  const startDate = options.startDate ?? todayIso();
  const maxMonths = options.maxMonths ?? MAX_AMORTIZATION_MONTHS;
  const warnings: string[] = [];

  let balance = nonNegative(debt.balance);
  const payment = nonNegative(monthlyPayment);
  const schedule: AmortizationMonth[] = [];
  let totalInterest = 0;
  let totalPaid = 0;

  if (balance <= 0) {
    return {
      debtId: debt.id,
      name: debt.name,
      amortizes: true,
      monthsToPayoff: 0,
      payoffDate: startDate,
      totalInterest: 0,
      totalPaid: 0,
      schedule: [],
      warnings: [],
    };
  }

  const firstMonthInterest = balance * rateForMonth(debt, startDate);
  const extraOneTime = nonNegative(options.extraOneTime);

  if (payment + extraOneTime <= firstMonthInterest + 0.005) {
    warnings.push(
      `A payment of ${payment.toFixed(2)} does not cover the ${roundMoney(firstMonthInterest).toFixed(2)} of interest this debt accrues in a month, so the balance would grow rather than fall. Increase the payment to make progress.`,
    );
    return {
      debtId: debt.id,
      name: debt.name,
      amortizes: false,
      monthsToPayoff: null,
      payoffDate: null,
      totalInterest: 0,
      totalPaid: 0,
      schedule: [],
      warnings,
    };
  }

  for (let month = 0; month < maxMonths && balance > 0; month++) {
    const date = addMonths(startDate, month);
    const rate = rateForMonth(debt, date);
    const interest = roundMoney(balance * rate);
    const available = payment + (month === 0 ? extraOneTime : 0);
    // The final payment is only what is left, never the full instalment.
    const thisPayment = roundMoney(Math.min(available, balance + interest));
    const principal = roundMoney(thisPayment - interest);
    const endingBalance = roundMoney(Math.max(0, balance - principal));

    schedule.push({
      monthIndex: month,
      date,
      startingBalance: roundMoney(balance),
      interest,
      principal,
      payment: thisPayment,
      endingBalance,
    });

    totalInterest = roundMoney(totalInterest + interest);
    totalPaid = roundMoney(totalPaid + thisPayment);
    balance = endingBalance;

    if (principal <= 0) {
      // Can happen when a promo rate expires mid-schedule and the payment no
      // longer covers interest at the new rate.
      warnings.push(
        `From ${date} the payment stops covering this debt’s interest — often because a promotional rate ended. The projection stops here.`,
      );
      return {
        debtId: debt.id,
        name: debt.name,
        amortizes: false,
        monthsToPayoff: null,
        payoffDate: null,
        totalInterest,
        totalPaid,
        schedule,
        warnings,
      };
    }
  }

  if (balance > 0) {
    warnings.push(
      `At this payment the balance is still not clear after ${maxMonths} months, so NetShift stops projecting there.`,
    );
    return {
      debtId: debt.id,
      name: debt.name,
      amortizes: false,
      monthsToPayoff: null,
      payoffDate: null,
      totalInterest,
      totalPaid,
      schedule,
      warnings,
    };
  }

  const months = schedule.length;
  return {
    debtId: debt.id,
    name: debt.name,
    amortizes: true,
    monthsToPayoff: months,
    payoffDate: addMonths(startDate, Math.max(0, months - 1)),
    totalInterest,
    totalPaid,
    schedule,
    warnings,
  };
}

/**
 * Orders debts for a payoff strategy.
 *
 * Snowball orders by smallest balance (fastest first win); avalanche by
 * highest rate (least total interest). A promotional rate is *not* used for
 * avalanche ordering — paying down a 0% promo ahead of a 24% card because the
 * promo is "currently 0%" is exactly the mistake the ordering should avoid.
 */
export function orderDebts(debts: readonly Debt[], strategy: PayoffStrategy): Debt[] {
  const list = [...debts].filter((d) => nonNegative(d.balance) > 0);
  if (strategy === 'as_entered') return list;
  if (strategy === 'snowball') {
    return list.sort((a, b) => a.balance - b.balance || b.apr - a.apr);
  }
  return list.sort((a, b) => b.apr - a.apr || a.balance - b.balance);
}

export interface PayoffPlanInput {
  debts: readonly Debt[];
  strategy: PayoffStrategy;
  /** Recurring amount above the sum of minimums. */
  extraMonthlyPayment?: number;
  /** One-off lump sum applied in month 0 to the first debt in order. */
  oneTimeExtraPayment?: number;
  /**
   * Extra net earnings from additional shifts, converted to a monthly figure
   * by the caller. Added to the recurring extra.
   */
  extraFromShiftsMonthly?: number;
  startDate?: IsoDate;
  maxMonths?: number;
}

export interface PayoffPlanResult {
  strategy: PayoffStrategy;
  order: { debtId: string; name: string }[];
  perDebt: DebtPayoffResult[];
  totalInterest: number;
  totalPaid: number;
  monthsToDebtFree: number | null;
  debtFreeDate: IsoDate | null;
  monthlyPayment: number;
  amortizes: boolean;
  warnings: string[];
}

/**
 * Runs a full snowball/avalanche plan.
 *
 * Minimums are paid on every debt each month; the extra goes entirely to the
 * first debt in the strategy order, and when that debt clears, its minimum
 * *plus* the extra rolls to the next — which is what makes a snowball a
 * snowball rather than just a set of independent payoffs.
 */
export function buildPayoffPlan(input: PayoffPlanInput): PayoffPlanResult {
  const startDate = input.startDate ?? todayIso();
  const maxMonths = input.maxMonths ?? MAX_AMORTIZATION_MONTHS;
  const ordered = orderDebts(input.debts, input.strategy);
  const warnings: string[] = [];

  const state = ordered.map((d) => ({
    debt: d,
    balance: nonNegative(d.balance),
    interest: 0,
    paid: 0,
    schedule: [] as AmortizationMonth[],
    clearedMonth: null as number | null,
  }));

  const extraRecurring =
    nonNegative(input.extraMonthlyPayment) + nonNegative(input.extraFromShiftsMonthly);
  let oneTime = nonNegative(input.oneTimeExtraPayment);

  const totalMinimums = state.reduce((sum, s) => sum + nonNegative(s.debt.minimumPayment), 0);
  const monthlyPayment = roundMoney(totalMinimums + extraRecurring);

  if (state.length === 0) {
    return {
      strategy: input.strategy,
      order: [],
      perDebt: [],
      totalInterest: 0,
      totalPaid: 0,
      monthsToDebtFree: 0,
      debtFreeDate: startDate,
      monthlyPayment: 0,
      amortizes: true,
      warnings: ['No debts with a balance to pay off.'],
    };
  }

  let month = 0;
  let stalled = false;

  for (; month < maxMonths; month++) {
    const date = addMonths(startDate, month);
    const remaining = state.filter((s) => s.balance > 0);
    if (remaining.length === 0) break;

    // 1. Accrue interest and take the minimum from every active debt.
    let freed = extraRecurring + (month === 0 ? oneTime : 0);
    if (month === 0) oneTime = 0;

    const monthRows = remaining.map((s) => {
      const rate = rateForMonth(s.debt, date);
      const interest = roundMoney(s.balance * rate);
      const minimum = Math.min(nonNegative(s.debt.minimumPayment), s.balance + interest);
      return { s, interest, minimum, startingBalance: s.balance, applied: minimum };
    });

    // A cleared debt's minimum is freed for the debts still outstanding.
    const clearedMinimums = state
      .filter((s) => s.balance <= 0)
      .reduce((sum, s) => sum + nonNegative(s.debt.minimumPayment), 0);
    freed += clearedMinimums;

    // 2. Apply minimums, then direct all spare cash at the first debt in order.
    for (const row of monthRows) {
      row.s.balance = roundMoney(row.startingBalance + row.interest - row.applied);
      if (row.s.balance < 0) {
        freed += -row.s.balance;
        row.s.balance = 0;
      }
    }

    for (const row of monthRows) {
      if (freed <= 0) break;
      if (row.s.balance <= 0) continue;
      const take = Math.min(freed, row.s.balance);
      row.s.balance = roundMoney(row.s.balance - take);
      row.applied = roundMoney(row.applied + take);
      freed = roundMoney(freed - take);
    }

    let anyProgress = false;
    for (const row of monthRows) {
      const principal = roundMoney(row.applied - row.interest);
      if (principal > 0) anyProgress = true;
      row.s.interest = roundMoney(row.s.interest + row.interest);
      row.s.paid = roundMoney(row.s.paid + row.applied);
      row.s.schedule.push({
        monthIndex: month,
        date,
        startingBalance: roundMoney(row.startingBalance),
        interest: row.interest,
        principal,
        payment: roundMoney(row.applied),
        endingBalance: row.s.balance,
      });
      if (row.s.balance <= 0 && row.s.clearedMonth === null) {
        row.s.clearedMonth = month;
      }
    }

    if (!anyProgress) {
      stalled = true;
      warnings.push(
        'The combined minimum payments do not cover the interest these debts accrue each month, so the balances would grow. Increase the monthly payment to build a payoff plan.',
      );
      break;
    }
  }

  const cleared = state.every((s) => s.balance <= 0);
  const monthsToDebtFree = cleared && !stalled ? month : null;

  if (!cleared && !stalled) {
    warnings.push(
      `These debts are still not clear after ${maxMonths} months at this payment, so NetShift stops projecting there.`,
    );
  }

  const perDebt: DebtPayoffResult[] = state.map((s) => ({
    debtId: s.debt.id,
    name: s.debt.name,
    amortizes: s.balance <= 0,
    monthsToPayoff: s.clearedMonth === null ? null : s.clearedMonth + 1,
    payoffDate: s.clearedMonth === null ? null : addMonths(startDate, s.clearedMonth),
    totalInterest: s.interest,
    totalPaid: s.paid,
    schedule: s.schedule,
    warnings: [],
  }));

  return {
    strategy: input.strategy,
    order: ordered.map((d) => ({ debtId: d.id, name: d.name })),
    perDebt,
    totalInterest: roundMoney(state.reduce((sum, s) => sum + s.interest, 0)),
    totalPaid: roundMoney(state.reduce((sum, s) => sum + s.paid, 0)),
    monthsToDebtFree,
    debtFreeDate:
      monthsToDebtFree === null ? null : addMonths(startDate, Math.max(0, monthsToDebtFree - 1)),
    monthlyPayment,
    amortizes: cleared && !stalled,
    warnings,
  };
}

export interface StrategyComparison {
  snowball: PayoffPlanResult;
  avalanche: PayoffPlanResult;
  /** Positive when avalanche saves interest relative to snowball. */
  interestSavedByAvalanche: number;
  monthsSavedByAvalanche: number | null;
  recommendation: string;
}

/** Runs both orderings against the same money so they can be compared fairly. */
export function compareStrategies(input: Omit<PayoffPlanInput, 'strategy'>): StrategyComparison {
  const snowball = buildPayoffPlan({ ...input, strategy: 'snowball' });
  const avalanche = buildPayoffPlan({ ...input, strategy: 'avalanche' });

  const interestSaved = roundMoney(snowball.totalInterest - avalanche.totalInterest);
  const monthsSaved =
    snowball.monthsToDebtFree !== null && avalanche.monthsToDebtFree !== null
      ? snowball.monthsToDebtFree - avalanche.monthsToDebtFree
      : null;

  let recommendation: string;
  if (!snowball.amortizes || !avalanche.amortizes) {
    recommendation =
      'Neither ordering clears these balances at the current payment. The payment amount matters far more than the ordering here.';
  } else if (Math.abs(interestSaved) < 25) {
    recommendation =
      'The two orderings finish within about the same total interest. Pick whichever you will actually stick to — for most people that is the snowball, because the first debt clears sooner.';
  } else if (interestSaved > 0) {
    recommendation = `Avalanche (highest rate first) costs about ${Math.abs(interestSaved).toFixed(2)} less in interest. Snowball clears its first balance sooner, which some people find easier to keep up.`;
  } else {
    recommendation = `Snowball comes out about ${Math.abs(interestSaved).toFixed(2)} cheaper here, which happens when the smallest balance also carries a high rate.`;
  }

  return {
    snowball,
    avalanche,
    interestSavedByAvalanche: interestSaved,
    monthsSavedByAvalanche: monthsSaved,
    recommendation,
  };
}

/** Interest and time saved by adding money to a baseline plan. */
export function scenarioDelta(
  baseline: PayoffPlanResult,
  scenario: PayoffPlanResult,
): { interestSaved: number; monthsSaved: number | null; description: string } {
  const interestSaved = roundMoney(baseline.totalInterest - scenario.totalInterest);
  const monthsSaved =
    baseline.monthsToDebtFree !== null && scenario.monthsToDebtFree !== null
      ? baseline.monthsToDebtFree - scenario.monthsToDebtFree
      : null;

  let description: string;
  if (!scenario.amortizes) {
    description = 'This scenario still does not clear the balances.';
  } else if (monthsSaved === null) {
    description = `Saves about ${interestSaved.toFixed(2)} in interest.`;
  } else {
    description = `Debt-free about ${monthsSaved} ${monthsSaved === 1 ? 'month' : 'months'} sooner and roughly ${interestSaved.toFixed(2)} less interest.`;
  }

  return { interestSaved, monthsSaved, description };
}

/** Converts extra shifts per month into the monthly extra payment they fund. */
export function shiftsToMonthlyExtra(netPerShift: number, shiftsPerMonth: number): number {
  return roundMoney(nonNegative(netPerShift) * nonNegative(shiftsPerMonth));
}

/** Total monthly minimum across a set of debts. */
export function totalMinimums(debts: readonly Debt[]): number {
  return roundMoney(debts.reduce((sum, d) => sum + nonNegative(d.minimumPayment), 0));
}

/** Simple monthly interest accrual, for showing the cost of waiting. */
export function monthlyInterestCost(debts: readonly Debt[]): number {
  return roundMoney(debts.reduce((sum, d) => sum + nonNegative(d.balance) * monthlyRate(d.apr), 0));
}
