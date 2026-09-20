import { describe, expect, it } from 'vitest';
import {
  auditPaycheck,
  buildExpectedPaycheck,
  detectAnomalies,
  type ActualPaycheck,
} from './audit';

const emptyActual: ActualPaycheck = {
  grossPay: null,
  netPay: null,
  hoursWorked: null,
  regularHours: null,
  overtimeHours: null,
  doubleTimeHours: null,
  hourlyRate: null,
  shiftDifferentialAmount: null,
  sundayPremiumAmount: null,
  rolePremiumAmount: null,
  perDiemAmount: null,
  federalTax: null,
  stateTax: null,
  socialSecurity: null,
  medicare: null,
  otherDeductionsTotal: null,
};

describe('buildExpectedPaycheck', () => {
  it('prices buckets at the base rate with no premiums', () => {
    const expected = buildExpectedPaycheck({
      buckets: { regular: 80, overtime: 10, doubleTime: 0 },
      baseRate: 40,
    });
    expect(expected.gross).toBe(80 * 40 + 10 * 60);
  });

  it('loads a shift premium onto the rate for the hours it covers', () => {
    const expected = buildExpectedPaycheck({
      buckets: { regular: 80, overtime: 0, doubleTime: 0 },
      baseRate: 40,
      shiftPremiumPerHour: 0.8,
      shiftPremiumHours: 80,
    });
    expect(expected.effectiveRate).toBeCloseTo(40.8, 4);
    expect(expected.gross).toBe(80 * 40.8);
    expect(expected.shiftDifferentialAmount).toBe(64);
  });

  it('prorates a premium that only covers part of the period', () => {
    const expected = buildExpectedPaycheck({
      buckets: { regular: 80, overtime: 0, doubleTime: 0 },
      baseRate: 40,
      shiftPremiumPerHour: 0.8,
      shiftPremiumHours: 40, // only one of the two weeks was on nights
    });
    expect(expected.effectiveRate).toBeCloseTo(40.4, 4);
  });

  it('adds a Sunday premium as a flat amount on top', () => {
    const expected = buildExpectedPaycheck({
      buckets: { regular: 80, overtime: 0, doubleTime: 0 },
      baseRate: 40,
      sundayPremiumAmount: 120,
    });
    expect(expected.gross).toBe(80 * 40 + 120);
  });

  it('keeps per diem out of gross', () => {
    const expected = buildExpectedPaycheck({
      buckets: { regular: 80, overtime: 0, doubleTime: 0 },
      baseRate: 40,
      perDiemAmount: 500,
    });
    expect(expected.gross).toBe(3200);
    expect(expected.perDiemAmount).toBe(500);
  });
});

describe('auditPaycheck — tone', () => {
  const expected = buildExpectedPaycheck({
    buckets: { regular: 80, overtime: 10, doubleTime: 0 },
    baseRate: 40,
  });

  it('never states that payroll made an error', () => {
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3000, hoursWorked: 90 });
    const allText = [
      result.verdict,
      ...result.summary.map((l) => l.message),
      ...result.detail.map((l) => l.message),
    ]
      .join(' ')
      .toLowerCase();
    expect(allText).not.toContain('payroll made');
    expect(allText).not.toContain('error');
    expect(allText).not.toContain('mistake');
    expect(allText).not.toContain('underpaid');
    expect(allText).not.toContain('shorted');
  });

  it('uses the approved review phrasing on a real difference', () => {
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3000, hoursWorked: 90 });
    const grossLine = result.summary[0];
    expect(grossLine.severity).toBe('review');
    expect(grossLine.message).toContain('NetShift found a difference');
    expect(grossLine.message).toContain('confirming the pay-period dates');
  });

  it('flags estimates as incomplete rather than authoritative', () => {
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3000, hoursWorked: 90 });
    expect(result.verdict).toContain('may not include every employer-specific payroll rule');
  });
});

describe('auditPaycheck — classification', () => {
  const expected = buildExpectedPaycheck({
    buckets: { regular: 80, overtime: 10, doubleTime: 0 },
    baseRate: 40,
  }); // gross 3800

  it('treats a rounding-sized difference as a match', () => {
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3800.4, hoursWorked: 90 });
    expect(result.summary[0].severity).toBe('match');
    expect(result.summary[0].severity).toBe('match');
    expect(result.findings).toHaveLength(0);
    expect(result.verdict).toContain('matches what NetShift expected');
  });

  it('treats a difference that is above tolerance but below review as minor', () => {
    // $40 clears the $1/0.5% tolerance but is only 1.05% — under the 2% that
    // review also requires, so it lands in between.
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3760, hoursWorked: 90 });
    expect(result.summary[0].severity).toBe('minor');
    expect(result.verdict).toContain('Small differences only');
  });

  it('requires both an absolute and a percentage breach before flagging review', () => {
    // $30 off a $3,800 cheque is 0.8% — under the 2% review threshold.
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3770, hoursWorked: 90 });
    expect(result.summary[0].severity).toBe('minor');
  });

  it('tolerates a quarter hour of timekeeping rounding', () => {
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3800, hoursWorked: 90.2 });
    expect(result.summary[1].severity).toBe('match');
  });

  it('flags an hour or more of missing time for review', () => {
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3800, hoursWorked: 88 });
    expect(result.summary[1].severity).toBe('review');
  });

  it('flags any rate difference above a cent', () => {
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3800, hourlyRate: 39.5 });
    const rateLine = result.detail.find((l) => l.kind === 'base_rate')!;
    expect(rateLine.severity).toBe('review');
    expect(rateLine.message).toContain('wage step');
  });

  it('counts comparisons that could not be made', () => {
    const result = auditPaycheck(expected, emptyActual);
    expect(result.incomparableCount).toBeGreaterThan(0);
    expect(result.verdict).toContain('Not enough information');
  });

  it('orders findings by severity then magnitude', () => {
    const result = auditPaycheck(expected, {
      ...emptyActual,
      grossPay: 3000,
      hoursWorked: 89.5,
      hourlyRate: 40,
    });
    expect(result.findings[0].severity).toBe('review');
  });

  it('reports taxes without claiming what withholding should have been', () => {
    const result = auditPaycheck(expected, {
      ...emptyActual,
      grossPay: 3800,
      federalTax: 400,
      socialSecurity: 235.6,
      medicare: 55.1,
    });
    const taxLine = result.detail.find((l) => l.kind === 'taxes')!;
    expect(taxLine.expected).toBeNull();
    expect(taxLine.message).toContain('does not calculate what your withholding should be');
  });

  it('shows net pay for reference rather than comparing it', () => {
    const result = auditPaycheck(expected, { ...emptyActual, grossPay: 3800, netPay: 2700 });
    const netLine = result.detail.find((l) => l.kind === 'net')!;
    expect(netLine.insufficientData).toBe(true);
    expect(netLine.message).toContain('does not estimate exact withholding');
  });
});

describe('detectAnomalies', () => {
  const normal = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`,
    payDate: `2026-01-${String(i + 1).padStart(2, '0')}`,
    grossPay: 3000 + i * 20,
    netPay: 2250 + i * 15,
    hoursWorked: 80,
  }));

  it('reports insufficient history below the minimum', () => {
    const result = detectAnomalies(normal.slice(0, 2));
    expect(result.sufficientHistory).toBe(false);
    expect(result.note).toContain('at least 4');
  });

  it('finds nothing unusual in a steady history', () => {
    const result = detectAnomalies(normal);
    expect(result.findings).toHaveLength(0);
    expect(result.note).toContain('Nothing in your paycheck history');
  });

  it('flags a paycheck far outside the usual pattern', () => {
    const withOutlier = [
      ...normal,
      { id: 'odd', payDate: '2026-03-01', grossPay: 9000, netPay: 6500, hoursWorked: 80 },
    ];
    const result = detectAnomalies(withOutlier);
    expect(result.findings.some((f) => f.paycheckId === 'odd')).toBe(true);
    expect(result.findings[0].direction).toBe('above');
  });

  it('is not thrown off by one huge check when judging the rest', () => {
    // A mean/stdev approach would widen so much that nothing else could flag.
    const withOutlier = [
      ...normal,
      { id: 'huge', payDate: '2026-03-01', grossPay: 30_000, netPay: 20_000, hoursWorked: 200 },
      { id: 'tiny', payDate: '2026-03-15', grossPay: 200, netPay: 180, hoursWorked: 6 },
    ];
    const result = detectAnomalies(withOutlier);
    const flagged = result.findings.map((f) => f.paycheckId);
    expect(flagged).toContain('huge');
    expect(flagged).toContain('tiny');
  });

  it('phrases findings as things that may be worth reviewing', () => {
    const withOutlier = [
      ...normal,
      { id: 'odd', payDate: '2026-03-01', grossPay: 9000, netPay: 6500, hoursWorked: 80 },
    ];
    const result = detectAnomalies(withOutlier);
    expect(result.findings[0].message).toContain('may be worth reviewing');
    expect(result.findings[0].message).toContain('often a real change');
  });

  it('skips a metric with no spread rather than flagging everything', () => {
    const identical = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      payDate: null,
      grossPay: 3000,
      netPay: 2250,
      hoursWorked: 80,
    }));
    expect(detectAnomalies(identical).findings).toHaveLength(0);
  });
});
