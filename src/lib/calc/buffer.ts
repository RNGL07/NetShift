/**
 * Feature 5 — Variable-Income Buffer.
 *
 * The specific failure mode this exists to catch: someone whose bills quietly
 * grew to fit a year of heavy overtime, and who is one slow quarter away from
 * not covering the essentials. So the headline number is not "3 months of
 * expenses" — it is the gap between a *base-pay-only* paycheck and what they
 * have committed to.
 */

import { paychecksPerYear, type PayPeriodKind } from './hours';
import { nonNegative, num, roundMoney, roundTo } from './money';

export interface PaycheckSample {
  payDate: string | null;
  grossPay: number | null;
  netPay: number | null;
  hoursWorked: number | null;
  /** Overtime hours, when the stub broke them out. */
  overtimeHours?: number | null;
}

export interface BufferInput {
  history: readonly PaycheckSample[];
  frequency: PayPeriodKind;
  /** Essential recurring obligations per month. */
  monthlyEssentialExpenses: number;
  /** All recurring obligations per month, essential or not. */
  monthlyTotalObligations?: number;
  /** Months of cover the user wants. Default 3. */
  targetMonthsOfCover?: number;
  /** Their base hourly rate, for the overtime-hours estimate. */
  baseRate?: number;
  overtimeMultiplier?: number;
  /** Cash currently set aside. */
  currentBufferBalance?: number;
  /** Below this many paychecks the result is explicitly low-confidence. */
  minHistory?: number;
}

export interface BufferResult {
  sampleSize: number;
  sufficientHistory: boolean;
  confidence: 'none' | 'low' | 'moderate' | 'good';

  lowestNormalPaycheck: number | null;
  averagePaycheck: number | null;
  averageBasePayOnlyPaycheck: number | null;
  medianPaycheck: number | null;
  highestPaycheck: number | null;

  /** Coefficient of variation of take-home, as a percentage. */
  incomeVariabilityPct: number | null;
  /** Share of average take-home that comes from overtime. */
  overtimeShareOfIncomePct: number | null;

  monthlyEssentialExpenses: number;
  monthlyIncomeFromBasePay: number | null;
  /** Monthly shortfall if overtime stopped entirely. */
  monthlyGapWithoutOvertime: number | null;

  recommendedBuffer: number;
  currentBufferBalance: number;
  bufferGap: number;
  monthsOfCoverToday: number | null;

  /** Obligations that only work if overtime keeps coming. */
  obligationsDependentOnOvertime: number | null;
  overtimeHoursPerMonthToSustain: number | null;

  explanation: string[];
  warnings: string[];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Percentile using linear interpolation; `p` is 0–1. */
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Derives buffer guidance from real paycheck history.
 *
 * "Lowest normal" is the 10th percentile rather than the outright minimum: a
 * single two-day check from a week of unpaid leave is not the floor anyone
 * should budget to, and sizing a buffer off it produces a number so large it
 * gets ignored.
 */
export function calculateBuffer(input: BufferInput): BufferResult {
  const minHistory = input.minHistory ?? 3;
  const usable = input.history.filter(
    (p): p is PaycheckSample & { netPay: number } => p.netPay !== null && p.netPay > 0,
  );
  const nets = usable.map((p) => p.netPay);
  const sampleSize = nets.length;

  const essentials = nonNegative(input.monthlyEssentialExpenses);
  const totalObligations = nonNegative(
    input.monthlyTotalObligations ?? input.monthlyEssentialExpenses,
  );
  const targetMonths = Math.max(0.5, num(input.targetMonthsOfCover, 3));
  const currentBufferBalance = nonNegative(input.currentBufferBalance);

  const explanation: string[] = [];
  const warnings: string[] = [];

  if (sampleSize === 0) {
    return {
      sampleSize: 0,
      sufficientHistory: false,
      confidence: 'none',
      lowestNormalPaycheck: null,
      averagePaycheck: null,
      averageBasePayOnlyPaycheck: null,
      medianPaycheck: null,
      highestPaycheck: null,
      incomeVariabilityPct: null,
      overtimeShareOfIncomePct: null,
      monthlyEssentialExpenses: roundMoney(essentials),
      monthlyIncomeFromBasePay: null,
      monthlyGapWithoutOvertime: null,
      recommendedBuffer: roundMoney(essentials * targetMonths),
      currentBufferBalance: roundMoney(currentBufferBalance),
      bufferGap: roundMoney(Math.max(0, essentials * targetMonths - currentBufferBalance)),
      monthsOfCoverToday: essentials > 0 ? roundTo(currentBufferBalance / essentials, 2) : null,
      obligationsDependentOnOvertime: null,
      overtimeHoursPerMonthToSustain: null,
      explanation: [
        `With no paycheck history saved, NetShift falls back to the common rule of thumb: ${targetMonths} months of essential expenses.`,
        'Add a few pay stubs and this recommendation will be based on your own income instead of a generic rule.',
      ],
      warnings: ['This recommendation is based on no paycheck history at all.'],
    };
  }

  const avg = mean(nets);
  const med = medianOf(nets);
  const lowestNormal = percentile(nets, 0.1);
  const highest = Math.max(...nets);

  const stdev =
    sampleSize > 1
      ? Math.sqrt(nets.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (sampleSize - 1))
      : 0;
  const variability = avg > 0 ? roundTo((stdev / avg) * 100, 2) : 0;

  // Base-pay-only: checks whose stub reported zero overtime hours. When no stub
  // breaks out overtime, fall back to the bottom quartile as a proxy and say so.
  const baseOnly = usable.filter(
    (p) => p.overtimeHours !== null && p.overtimeHours !== undefined && p.overtimeHours <= 0,
  );
  let avgBaseOnly: number;
  let baseOnlyIsProxy = false;
  if (baseOnly.length >= 2) {
    avgBaseOnly = mean(baseOnly.map((p) => p.netPay));
  } else {
    avgBaseOnly = percentile(nets, 0.25);
    baseOnlyIsProxy = true;
  }

  const perYear = paychecksPerYear(input.frequency);
  const monthlyFromBase = (avgBaseOnly * perYear) / 12;
  const monthlyAverage = (avg * perYear) / 12;

  const overtimeShare = avg > 0 ? roundTo(((avg - avgBaseOnly) / avg) * 100, 2) : 0;
  const monthlyGap = roundMoney(Math.max(0, essentials - monthlyFromBase));
  const obligationsDependentOnOvertime = roundMoney(
    Math.max(0, totalObligations - monthlyFromBase),
  );

  // Buffer covers the shortfall for the target number of months, with a floor
  // of one month of essentials so the number is never trivially small.
  const shortfallBuffer = monthlyGap * targetMonths;
  const conventionalBuffer = essentials * targetMonths;
  const variabilityBuffer = (avg - lowestNormal) * (perYear / 12) * targetMonths;
  const recommendedBuffer = roundMoney(
    Math.max(
      essentials,
      shortfallBuffer,
      Math.min(conventionalBuffer, Math.max(variabilityBuffer, monthlyGap * targetMonths)),
    ),
  );

  const baseRate = nonNegative(input.baseRate);
  const otMultiplier = num(input.overtimeMultiplier, 1.5);
  // Withholding on overtime is estimated from this user's own average
  // deduction rate, which is the best available proxy.
  const grossValues = usable.filter((p) => p.grossPay && p.grossPay > 0);
  const avgDeductionRate =
    grossValues.length > 0
      ? mean(grossValues.map((p) => 1 - p.netPay / (p.grossPay as number)))
      : 0.25;
  const netPerOvertimeHour = baseRate * otMultiplier * (1 - avgDeductionRate);
  const overtimeHoursPerMonthToSustain =
    netPerOvertimeHour > 0 && obligationsDependentOnOvertime > 0
      ? roundTo(obligationsDependentOnOvertime / netPerOvertimeHour, 1)
      : obligationsDependentOnOvertime <= 0
        ? 0
        : null;

  const confidence: BufferResult['confidence'] =
    sampleSize >= 12 ? 'good' : sampleSize >= 6 ? 'moderate' : 'low';
  const sufficientHistory = sampleSize >= minHistory;

  explanation.push(
    `Based on ${sampleSize} saved ${sampleSize === 1 ? 'paycheck' : 'paychecks'}. Your take-home has ranged from ${roundMoney(Math.min(...nets)).toFixed(2)} to ${roundMoney(highest).toFixed(2)}.`,
  );
  explanation.push(
    `"Lowest normal" is the 10th percentile of your history (${roundMoney(lowestNormal).toFixed(2)}) rather than your single smallest check, so one unusual short week does not set your whole budget.`,
  );
  if (baseOnlyIsProxy) {
    explanation.push(
      'None of your saved stubs broke out overtime hours, so a base-pay-only paycheck is approximated by the bottom quarter of your history. Saving stubs that show overtime hours will sharpen this.',
    );
  }
  if (obligationsDependentOnOvertime > 0) {
    explanation.push(
      `About ${roundMoney(obligationsDependentOnOvertime).toFixed(2)} of your monthly obligations sit above what base pay alone brings in — that portion currently depends on overtime continuing.`,
    );
  } else {
    explanation.push('Your base pay alone covers the recurring obligations you have entered.');
  }

  if (!sufficientHistory) {
    warnings.push(
      `This is based on only ${sampleSize} ${sampleSize === 1 ? 'paycheck' : 'paychecks'}. Treat it as a rough starting point until you have at least ${minHistory}.`,
    );
  }
  if (variability > 25) {
    warnings.push(
      `Your take-home swings by about ${variability.toFixed(0)}% around its average. Income that variable usually needs a larger buffer than a salaried rule of thumb suggests.`,
    );
  }
  if (essentials <= 0) {
    warnings.push(
      'Add your essential monthly expenses to get a buffer figure grounded in your real costs.',
    );
  }

  return {
    sampleSize,
    sufficientHistory,
    confidence,
    lowestNormalPaycheck: roundMoney(lowestNormal),
    averagePaycheck: roundMoney(avg),
    averageBasePayOnlyPaycheck: roundMoney(avgBaseOnly),
    medianPaycheck: roundMoney(med),
    highestPaycheck: roundMoney(highest),
    incomeVariabilityPct: variability,
    overtimeShareOfIncomePct: Math.max(0, overtimeShare),
    monthlyEssentialExpenses: roundMoney(essentials),
    monthlyIncomeFromBasePay: roundMoney(monthlyFromBase),
    monthlyGapWithoutOvertime: monthlyGap,
    recommendedBuffer,
    currentBufferBalance: roundMoney(currentBufferBalance),
    bufferGap: roundMoney(Math.max(0, recommendedBuffer - currentBufferBalance)),
    monthsOfCoverToday: essentials > 0 ? roundTo(currentBufferBalance / essentials, 2) : null,
    obligationsDependentOnOvertime,
    overtimeHoursPerMonthToSustain,
    explanation: [
      ...explanation,
      `Average take-home across your history is ${roundMoney(monthlyAverage).toFixed(2)}/month; base pay alone is about ${roundMoney(monthlyFromBase).toFixed(2)}/month.`,
    ],
    warnings,
  };
}
