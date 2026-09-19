import { describe, expect, it } from 'vitest';
import { parsePayStubText } from './paystub';
import { parseWageSheetText } from './wageSheet';
import { moneyIn, normalizeDate, numberIn, parseLocalNumber, premiumIn } from './text';

describe('number extraction', () => {
  it('parses currency, commas, and parenthesised negatives', () => {
    expect(parseLocalNumber('$1,234.56')).toBe(1234.56);
    expect(parseLocalNumber('(1,234.56)')).toBe(-1234.56);
    expect(parseLocalNumber('-1234.56')).toBe(-1234.56);
    expect(parseLocalNumber('abc')).toBeNull();
  });

  it('requires a dollar sign or cents before reading a number as money', () => {
    expect(moneyIn('Check number 40123')).toBeNull();
    expect(moneyIn('Gross 3,240.50')).toBe(3240.5);
    expect(moneyIn('Gross $3240')).toBe(3240);
  });

  it('reads plain counts for hours', () => {
    expect(numberIn('Hours 86.5')).toBe(86.5);
  });

  it('rejects an implausibly large per-hour premium', () => {
    expect(premiumIn('Shift premium 0.80')).toBe(0.8);
    expect(premiumIn('Shift premium 12500')).toBeNull();
  });
});

describe('normalizeDate', () => {
  it('normalises the common payroll date formats', () => {
    expect(normalizeDate('2026-03-06')).toBe('2026-03-06');
    expect(normalizeDate('03/06/2026')).toBe('2026-03-06');
    expect(normalizeDate('3/6/26')).toBe('2026-03-06');
    expect(normalizeDate('Mar 6, 2026')).toBe('2026-03-06');
    expect(normalizeDate('March 6, 2026')).toBe('2026-03-06');
  });

  it('returns null for anything it cannot recognise', () => {
    expect(normalizeDate('sometime')).toBeNull();
    expect(normalizeDate(null)).toBeNull();
  });
});

const STUB = `
ACME MANUFACTURING
Employee: J RANGEL          Employee No 40123
Pay Date 03/06/2026         Pay Period Ending 02/28/2026
Hourly Rate 40.61
Regular Hours 80.00         Overtime Hours 12.50
Total Hours 92.50
Gross Pay $4,391.44
Federal Income Tax 612.30
State Income Tax 0.00
Social Security 272.27
Medicare 63.68
Total Deductions 1,248.25
Net Pay $3,143.19
`;

describe('parsePayStubText', () => {
  it('reads the core figures from a text-layer stub', () => {
    const { data, confidence } = parsePayStubText(STUB);
    expect(data.grossPay).toBe(4391.44);
    expect(data.netPay).toBe(3143.19);
    expect(data.hourlyRate).toBe(40.61);
    expect(data.hoursWorked).toBe(92.5);
    expect(data.regularHours).toBe(80);
    expect(data.overtimeHours).toBe(12.5);
    expect(confidence.confident).toBe(true);
  });

  it('normalises dates it finds', () => {
    const { data } = parsePayStubText(STUB);
    expect(data.payDate).toBe('2026-03-06');
    expect(data.periodEnd).toBe('2026-02-28');
  });

  it('reads each tax line separately', () => {
    const { data } = parsePayStubText(STUB);
    expect(data.federalTax).toBe(612.3);
    expect(data.socialSecurity).toBe(272.27);
    expect(data.medicare).toBe(63.68);
  });

  it('derives other deductions by subtracting the taxes from the total', () => {
    const { data } = parsePayStubText(STUB);
    // 1248.25 − (612.30 + 0 + 272.27 + 63.68)
    expect(data.otherDeductionsTotal).toBe(300);
  });

  it('refuses to claim confidence when net exceeds gross', () => {
    const broken = 'Gross Pay $100.00\nNet Pay $9,999.00';
    const { confidence } = parsePayStubText(broken);
    expect(confidence.confident).toBe(false);
    expect(confidence.reasons.join(' ')).toContain('larger than the gross');
  });

  it('refuses to claim confidence when the core figures are missing', () => {
    const { confidence } = parsePayStubText('Employee: J RANGEL\nDepartment: Maintenance');
    expect(confidence.confident).toBe(false);
    expect(confidence.coreFound).toBe(0);
  });

  it('handles a stub with no recognisable content without throwing', () => {
    expect(() => parsePayStubText('')).not.toThrow();
    expect(parsePayStubText('').data.grossPay).toBeNull();
  });

  it('picks the more specific label when several could match', () => {
    const text = 'Gross Pay 1000.00\nTotal Gross Pay 2000.00\nNet Pay 1500.00';
    // "total gross pay" is listed before "gross pay", so it wins.
    expect(parsePayStubText(text).data.grossPay).toBe(2000);
  });

  it('reads a value from the line below the label', () => {
    const text = 'Net Pay\n$2,100.00\nGross Pay\n$2,800.00';
    const { data } = parsePayStubText(text);
    expect(data.netPay).toBe(2100);
    expect(data.grossPay).toBe(2800);
  });
});

const WAGE_SHEET = `
ACME MANUFACTURING
Skilled Team Member
Effective Date 03/23/2026
Start             $35.90
6 Months          $39.15
1 Year            $40.61
2 Years           $43.55
3 Years (Top Rate) $47.95
Shift Premium     0.80
Team Leader Premium 2.25
`;

describe('parseWageSheetText', () => {
  it('reads the wage ladder in order', () => {
    const { data, confidence } = parseWageSheetText(WAGE_SHEET);
    expect(data.steps.map((s) => s.rate)).toEqual([35.9, 39.15, 40.61, 43.55, 47.95]);
    expect(data.steps[0].label).toBe('Start');
    expect(confidence.confident).toBe(true);
    expect(confidence.stepsFound).toBe(5);
  });

  it('reads the premiums', () => {
    const { data } = parseWageSheetText(WAGE_SHEET);
    expect(data.shiftPremium).toBe(0.8);
    expect(data.teamLeaderPremium).toBe(2.25);
  });

  it('finds the job classification from a heading when no label exists', () => {
    const { data } = parseWageSheetText(WAGE_SHEET);
    expect(data.trackLabel).toBe('Skilled Team Member');
  });

  it('prefers an explicit classification label over a heading', () => {
    const { data } = parseWageSheetText(`Job Classification: Maintenance Technician\n${WAGE_SHEET}`);
    expect(data.trackLabel).toBe('Maintenance Technician');
  });

  it('normalises the effective date', () => {
    expect(parseWageSheetText(WAGE_SHEET).data.effectiveDate).toBe('2026-03-23');
  });

  it('rejects implausible hourly rates', () => {
    const { data } = parseWageSheetText('Start 2026\n6 Months $39.15\n1 Year $40.61');
    expect(data.steps.every((s) => s.rate < 500)).toBe(true);
    expect(data.steps.map((s) => s.rate)).toEqual([39.15, 40.61]);
  });

  it('deduplicates identical step rows', () => {
    const { data } = parseWageSheetText('Start $35.90\nStart $35.90\n6 Months $39.15');
    expect(data.steps).toHaveLength(2);
  });

  it('reports low confidence when fewer than two steps are found', () => {
    const { confidence } = parseWageSheetText('Start $35.90');
    expect(confidence.confident).toBe(false);
    expect(confidence.reasons.join(' ')).toContain('Fewer than two wage steps');
  });

  it('handles empty input without throwing', () => {
    expect(() => parseWageSheetText('')).not.toThrow();
  });
});
