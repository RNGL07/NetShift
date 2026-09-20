/**
 * Feature 1 — Expected vs Actual Paycheck Audit.
 *
 * Tone is a product requirement, not a nicety. NetShift never has authoritative
 * payroll data: it has the user's own hours, the user's own idea of their rate,
 * and an OCR'd stub. So every finding is phrased as something *to check*, and
 * the severity vocabulary tops out at "worth reviewing". Nothing here says
 * payroll made a mistake, because nothing here can know that.
 */

import {
  DEFAULT_OVERTIME_RULES,
  grossFromBuckets,
  type HourBuckets,
  type OvertimeRules,
} from './hours';
import { roundMoney, roundTo } from './money';

export type DiscrepancySeverity = 'match' | 'minor' | 'review';

export type DiscrepancyKind =
  | 'gross'
  | 'net'
  | 'hours'
  | 'regular_hours'
  | 'overtime_hours'
  | 'double_time_hours'
  | 'base_rate'
  | 'shift_differential'
  | 'sunday_premium'
  | 'role_premium'
  | 'per_diem'
  | 'taxes'
  | 'deductions';

export interface AuditLine {
  kind: DiscrepancyKind;
  label: string;
  expected: number | null;
  actual: number | null;
  /** `actual − expected`. `null` when either side is missing. */
  difference: number | null;
  /** Difference as a share of expected, in percent. */
  differencePct: number | null;
  severity: DiscrepancySeverity;
  /** What the user should look at. Never an accusation. */
  message: string;
  /** `true` when there isn't enough data on either side to compare. */
  insufficientData: boolean;
  unit: 'money' | 'hours' | 'rate';
}

export interface AuditThresholds {
  /** Money differences at or below this are treated as rounding. */
  moneyToleranceAbs: number;
  /** …or at or below this share of the expected figure. */
  moneyTolerancePct: number;
  /** Money differences above this are flagged for review. */
  moneyReviewAbs: number;
  moneyReviewPct: number;
  /** Hours tolerance — a quarter hour is normal timekeeping rounding. */
  hoursToleranceAbs: number;
  hoursReviewAbs: number;
  /** Rate tolerance — a cent. */
  rateToleranceAbs: number;
}

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = {
  moneyToleranceAbs: 1,
  moneyTolerancePct: 0.5,
  moneyReviewAbs: 25,
  moneyReviewPct: 2,
  hoursToleranceAbs: 0.25,
  hoursReviewAbs: 1,
  rateToleranceAbs: 0.01,
};

export interface ExpectedPaycheck {
  buckets: HourBuckets;
  baseRate: number;
  /** Effective rate including premiums, used for the gross expectation. */
  effectiveRate: number;
  shiftDifferentialAmount: number;
  sundayPremiumAmount: number;
  rolePremiumAmount: number;
  perDiemAmount: number;
  gross: number;
}

export interface ActualPaycheck {
  grossPay: number | null;
  netPay: number | null;
  hoursWorked: number | null;
  regularHours: number | null;
  overtimeHours: number | null;
  doubleTimeHours: number | null;
  hourlyRate: number | null;
  shiftDifferentialAmount: number | null;
  sundayPremiumAmount: number | null;
  rolePremiumAmount: number | null;
  perDiemAmount: number | null;
  federalTax: number | null;
  stateTax: number | null;
  socialSecurity: number | null;
  medicare: number | null;
  otherDeductionsTotal: number | null;
}

export interface PaycheckAuditResult {
  /** The headline gross/net comparison — this is what free users see. */
  summary: AuditLine[];
  /** Line-by-line reconciliation — Pro. */
  detail: AuditLine[];
  /** Lines whose severity is `minor` or `review`, most significant first. */
  findings: AuditLine[];
  expectedGross: number;
  actualGross: number | null;
  grossDifference: number | null;
  /** Number of comparisons that could not be made for lack of data. */
  incomparableCount: number;
  /** Overall, plain-language verdict. */
  verdict: string;
}

/** Builds the gross NetShift expects from logged hours and the pay profile. */
export function buildExpectedPaycheck(params: {
  buckets: HourBuckets;
  baseRate: number;
  shiftPremiumPerHour?: number;
  shiftPremiumHours?: number;
  rolePremiumPerHour?: number;
  rolePremiumHours?: number;
  sundayPremiumAmount?: number;
  perDiemAmount?: number;
  rules?: OvertimeRules;
}): ExpectedPaycheck {
  const rules = params.rules ?? DEFAULT_OVERTIME_RULES;
  const shiftPer = Math.max(0, params.shiftPremiumPerHour ?? 0);
  const shiftHours = Math.max(0, params.shiftPremiumHours ?? 0);
  const rolePer = Math.max(0, params.rolePremiumPerHour ?? 0);
  const roleHours = Math.max(0, params.rolePremiumHours ?? 0);

  // Premiums load onto the base rate before the multiplier, so the "effective
  // rate" is what actually prices every bucket.
  const totalPaidHours =
    params.buckets.regular + params.buckets.overtime + params.buckets.doubleTime;
  const shiftShare = totalPaidHours > 0 ? Math.min(1, shiftHours / totalPaidHours) : 0;
  const roleShare = totalPaidHours > 0 ? Math.min(1, roleHours / totalPaidHours) : 0;
  const effective = params.baseRate + shiftPer * shiftShare + rolePer * roleShare;

  const wages = grossFromBuckets(params.buckets, effective, rules);
  const perDiem = Math.max(0, params.perDiemAmount ?? 0);
  const sundayPremium = Math.max(0, params.sundayPremiumAmount ?? 0);

  return {
    buckets: params.buckets,
    baseRate: params.baseRate,
    effectiveRate: roundTo(effective, 4),
    shiftDifferentialAmount: roundMoney(shiftPer * shiftHours),
    sundayPremiumAmount: roundMoney(sundayPremium),
    rolePremiumAmount: roundMoney(rolePer * roleHours),
    perDiemAmount: roundMoney(perDiem),
    gross: roundMoney(wages + sundayPremium),
  };
}

function classify(
  expected: number | null,
  actual: number | null,
  unit: AuditLine['unit'],
  thresholds: AuditThresholds,
): { severity: DiscrepancySeverity; difference: number | null; differencePct: number | null } {
  if (expected === null || actual === null) {
    return { severity: 'match', difference: null, differencePct: null };
  }
  const difference = roundTo(actual - expected, unit === 'rate' ? 4 : 2);
  const magnitude = Math.abs(difference);
  const pct = expected !== 0 ? Math.abs(difference / expected) * 100 : magnitude > 0 ? 100 : 0;

  let severity: DiscrepancySeverity;
  if (unit === 'hours') {
    severity =
      magnitude <= thresholds.hoursToleranceAbs
        ? 'match'
        : magnitude >= thresholds.hoursReviewAbs
          ? 'review'
          : 'minor';
  } else if (unit === 'rate') {
    severity = magnitude <= thresholds.rateToleranceAbs ? 'match' : 'review';
  } else {
    const withinTolerance =
      magnitude <= thresholds.moneyToleranceAbs || pct <= thresholds.moneyTolerancePct;
    const needsReview = magnitude >= thresholds.moneyReviewAbs && pct >= thresholds.moneyReviewPct;
    severity = withinTolerance ? 'match' : needsReview ? 'review' : 'minor';
  }

  return { severity, difference, differencePct: roundTo(pct, 2) };
}

function line(
  kind: DiscrepancyKind,
  label: string,
  expected: number | null,
  actual: number | null,
  unit: AuditLine['unit'],
  thresholds: AuditThresholds,
  messages: { match: string; minor: string; review: string; missing: string },
): AuditLine {
  const insufficientData = expected === null || actual === null;
  const { severity, difference, differencePct } = classify(expected, actual, unit, thresholds);
  return {
    kind,
    label,
    expected,
    actual,
    difference,
    differencePct,
    severity,
    insufficientData,
    unit,
    message: insufficientData ? messages.missing : messages[severity],
  };
}

/**
 * Compares what NetShift expected against what the stub says.
 *
 * Returns both a two-line summary (free) and the full reconciliation (Pro);
 * callers decide which to render, but the server decides which to *send*.
 */
export function auditPaycheck(
  expected: ExpectedPaycheck,
  actual: ActualPaycheck,
  thresholds: AuditThresholds = DEFAULT_AUDIT_THRESHOLDS,
): PaycheckAuditResult {
  const expectedTotalHours =
    expected.buckets.regular + expected.buckets.overtime + expected.buckets.doubleTime;

  const summary: AuditLine[] = [
    line('gross', 'Gross pay', expected.gross, actual.grossPay, 'money', thresholds, {
      match: 'Gross pay lines up with the hours you logged.',
      minor:
        'NetShift found a small difference in gross pay. Rounding or a premium NetShift does not know about can explain a gap this size.',
      review:
        'NetShift found a difference in gross pay. This may be worth reviewing — start by confirming the pay-period dates and the hours you logged.',
      missing: 'Add a gross pay figure to the stub, or log hours for this period, to compare.',
    }),
    line(
      'hours',
      'Total paid hours',
      roundTo(expectedTotalHours, 2),
      actual.hoursWorked,
      'hours',
      thresholds,
      {
        match: 'Paid hours match what you logged.',
        minor: 'Paid hours are slightly different from what you logged.',
        review:
          'NetShift found a difference in paid hours. Confirm the pay-period dates — hours worked near the boundary often land on the next stub.',
        missing: 'The stub did not show a total hours figure, so hours could not be compared.',
      },
    ),
  ];

  const expectedNet: number | null = null; // NetShift does not model withholding well enough to expect a net.

  const detail: AuditLine[] = [
    line(
      'regular_hours',
      'Regular hours',
      roundTo(expected.buckets.regular, 2),
      actual.regularHours,
      'hours',
      thresholds,
      {
        match: 'Regular hours match.',
        minor: 'Regular hours are slightly different.',
        review:
          'Regular and overtime hours split differently than NetShift expected. Check whether your employer applies daily overtime, weekly overtime, or both.',
        missing: 'The stub did not break out regular hours.',
      },
    ),
    line(
      'overtime_hours',
      'Overtime hours',
      roundTo(expected.buckets.overtime, 2),
      actual.overtimeHours,
      'hours',
      thresholds,
      {
        match: 'Overtime hours match.',
        minor: 'Overtime hours are slightly different.',
        review:
          'Overtime hours differ from NetShift’s estimate. This estimate may not include every employer-specific payroll rule.',
        missing: 'The stub did not break out overtime hours.',
      },
    ),
    line(
      'double_time_hours',
      'Double-time hours',
      roundTo(expected.buckets.doubleTime, 2),
      actual.doubleTimeHours,
      'hours',
      thresholds,
      {
        match: 'Double-time hours match.',
        minor: 'Double-time hours are slightly different.',
        review:
          'Double-time hours differ. Check how Sunday and holiday hours are treated in your pay profile.',
        missing: 'The stub did not break out double-time hours.',
      },
    ),
    line('base_rate', 'Base rate', expected.baseRate, actual.hourlyRate, 'rate', thresholds, {
      match: 'The base rate on the stub matches your pay profile.',
      minor: 'The base rate is slightly different from your pay profile.',
      review:
        'The rate on this stub is different from the one in your pay profile. If you moved up a wage step this period, update your pay profile.',
      missing: 'The stub did not show an hourly rate.',
    }),
    line(
      'shift_differential',
      'Shift differential',
      expected.shiftDifferentialAmount || null,
      actual.shiftDifferentialAmount,
      'money',
      thresholds,
      {
        match: 'Shift differential matches.',
        minor: 'Shift differential is slightly different.',
        review:
          'The shift differential NetShift expected is different. Confirm which shift you were on for each day of this period.',
        missing: 'No shift differential line was found on the stub.',
      },
    ),
    line(
      'sunday_premium',
      'Sunday premium',
      expected.sundayPremiumAmount || null,
      actual.sundayPremiumAmount,
      'money',
      thresholds,
      {
        match: 'Sunday premium matches.',
        minor: 'Sunday premium is slightly different.',
        review:
          'Sunday pay differs from your pay profile setting. Check whether Sunday is paid as regular, overtime, or double time where you work.',
        missing: 'No Sunday premium line was found on the stub.',
      },
    ),
    line(
      'role_premium',
      'Team leader / role premium',
      expected.rolePremiumAmount || null,
      actual.rolePremiumAmount,
      'money',
      thresholds,
      {
        match: 'Role premium matches.',
        minor: 'Role premium is slightly different.',
        review: 'The role premium differs. Confirm the hours you were in the role this period.',
        missing: 'No role premium line was found on the stub.',
      },
    ),
    line(
      'per_diem',
      'Per diem',
      expected.perDiemAmount || null,
      actual.perDiemAmount,
      'money',
      thresholds,
      {
        match: 'Per diem matches.',
        minor: 'Per diem is slightly different.',
        review: 'Per diem differs from what you expected. Confirm the number of eligible days.',
        missing: 'No per diem line was found on the stub.',
      },
    ),
    line('net', 'Net pay', expectedNet, actual.netPay, 'money', thresholds, {
      match: 'Net pay matches.',
      minor: 'Net pay is slightly different.',
      review: 'Net pay differs.',
      missing:
        'NetShift does not estimate exact withholding, so net pay is shown for reference rather than compared.',
    }),
  ];

  const taxTotal = [actual.federalTax, actual.stateTax, actual.socialSecurity, actual.medicare]
    .filter((v): v is number => v !== null)
    .reduce((sum, v) => sum + v, 0);
  const hasAnyTax = [
    actual.federalTax,
    actual.stateTax,
    actual.socialSecurity,
    actual.medicare,
  ].some((v) => v !== null);

  if (hasAnyTax && actual.grossPay) {
    const impliedPct = roundTo((taxTotal / actual.grossPay) * 100, 2);
    detail.push({
      kind: 'taxes',
      label: 'Taxes withheld',
      expected: null,
      actual: roundMoney(taxTotal),
      difference: null,
      differencePct: impliedPct,
      severity: 'match',
      insufficientData: false,
      unit: 'money',
      message: `Taxes on this stub are ${impliedPct.toFixed(1)}% of gross. NetShift reports this figure; it does not calculate what your withholding should be.`,
    });
  }

  const findings = [...summary, ...detail]
    .filter((l) => !l.insufficientData && l.severity !== 'match')
    .sort((a, b) => {
      const weight = (s: DiscrepancySeverity) => (s === 'review' ? 2 : 1);
      const byWeight = weight(b.severity) - weight(a.severity);
      if (byWeight !== 0) return byWeight;
      return Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0);
    });

  const grossLine = summary[0];
  const incomparableCount = [...summary, ...detail].filter((l) => l.insufficientData).length;

  let verdict: string;
  if (grossLine.insufficientData) {
    verdict =
      'Not enough information yet. Add a pay stub and log this period’s hours to run the comparison.';
  } else if (findings.some((f) => f.severity === 'review')) {
    verdict =
      'NetShift found a difference worth reviewing. These are estimates and may not include every employer-specific payroll rule.';
  } else if (findings.length > 0) {
    verdict =
      'Small differences only — the sort of gap rounding and minor premiums usually explain.';
  } else {
    verdict = 'This paycheck matches what NetShift expected from the hours you logged.';
  }

  return {
    summary,
    detail,
    findings,
    expectedGross: expected.gross,
    actualGross: actual.grossPay,
    grossDifference: grossLine.difference,
    incomparableCount,
    verdict,
  };
}

export interface HistoricalPaycheck {
  id: string;
  payDate: string | null;
  grossPay: number | null;
  netPay: number | null;
  hoursWorked: number | null;
}

export interface AnomalyFinding {
  paycheckId: string;
  payDate: string | null;
  metric: 'gross' | 'net' | 'hours' | 'deduction_rate';
  value: number;
  median: number;
  /** How many median-absolute-deviations from the median this sits. */
  deviations: number;
  direction: 'above' | 'below';
  message: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Flags paychecks that sit far from the user's own normal — Pro only.
 *
 * Uses the median and median absolute deviation rather than mean/stdev: a
 * single huge shutdown-overtime check would inflate a standard deviation so
 * much that nothing else could ever be flagged.
 */
export function detectAnomalies(
  history: readonly HistoricalPaycheck[],
  options: { minHistory?: number; deviationThreshold?: number } = {},
): { findings: AnomalyFinding[]; sufficientHistory: boolean; note: string } {
  const minHistory = options.minHistory ?? 4;
  const threshold = options.deviationThreshold ?? 3;

  if (history.length < minHistory) {
    return {
      findings: [],
      sufficientHistory: false,
      note: `Anomaly detection needs at least ${minHistory} saved paychecks. You have ${history.length}.`,
    };
  }

  const findings: AnomalyFinding[] = [];

  const metrics: {
    key: AnomalyFinding['metric'];
    label: string;
    pick: (p: HistoricalPaycheck) => number | null;
  }[] = [
    { key: 'gross', label: 'gross pay', pick: (p) => p.grossPay },
    { key: 'net', label: 'take-home pay', pick: (p) => p.netPay },
    { key: 'hours', label: 'paid hours', pick: (p) => p.hoursWorked },
    {
      key: 'deduction_rate',
      label: 'deduction rate',
      pick: (p) => (p.grossPay && p.netPay ? (1 - p.netPay / p.grossPay) * 100 : null),
    },
  ];

  for (const metric of metrics) {
    const points = history
      .map((p) => ({ p, value: metric.pick(p) }))
      .filter(
        (x): x is { p: HistoricalPaycheck; value: number } =>
          x.value !== null && Number.isFinite(x.value),
      );
    if (points.length < minHistory) continue;

    const values = points.map((x) => x.value);
    const med = median(values);
    // 1.4826 scales MAD to be comparable with a standard deviation for normal data.
    const mad = median(values.map((v) => Math.abs(v - med))) * 1.4826;
    if (mad <= 0) continue;

    for (const { p, value } of points) {
      const deviations = Math.abs(value - med) / mad;
      if (deviations < threshold) continue;
      const direction: 'above' | 'below' = value > med ? 'above' : 'below';
      findings.push({
        paycheckId: p.id,
        payDate: p.payDate,
        metric: metric.key,
        value: roundTo(value, 2),
        median: roundTo(med, 2),
        deviations: roundTo(deviations, 2),
        direction,
        message: `This paycheck’s ${metric.label} is well ${direction} your usual. That is often a real change — a shutdown week, a retro payment, a benefits change — but it may be worth reviewing.`,
      });
    }
  }

  findings.sort((a, b) => b.deviations - a.deviations);

  return {
    findings,
    sufficientHistory: true,
    note:
      findings.length === 0
        ? 'Nothing in your paycheck history stands out as unusual.'
        : `${findings.length} paycheck ${findings.length === 1 ? 'figure' : 'figures'} stand out from your usual pattern.`,
  };
}
