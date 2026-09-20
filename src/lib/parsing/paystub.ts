/**
 * Local (free, in-browser) pay-stub parsing.
 *
 * A PDF exported straight out of a payroll portal carries a real text layer, so
 * the numbers can be read without an upload and without spending an AI parse
 * from the user's allowance. Photos and scans fall through to the server-side
 * AI path.
 */

import { dateIn, findLabeledValue, moneyIn, normalizeDate, numberIn, toTextLines } from './text';

export interface ParsedPayStub {
  payDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  grossPay: number | null;
  federalTax: number | null;
  stateTax: number | null;
  socialSecurity: number | null;
  medicare: number | null;
  otherDeductionsTotal: number | null;
  netPay: number | null;
  hoursWorked: number | null;
  regularHours: number | null;
  overtimeHours: number | null;
  hourlyRate: number | null;
}

export interface ParseConfidence {
  fieldsFound: number;
  coreFound: number;
  /** `true` when the result is good enough to pre-fill a review form. */
  confident: boolean;
  reasons: string[];
}

export const EMPTY_PAY_STUB: ParsedPayStub = {
  payDate: null,
  periodStart: null,
  periodEnd: null,
  grossPay: null,
  federalTax: null,
  stateTax: null,
  socialSecurity: null,
  medicare: null,
  otherDeductionsTotal: null,
  netPay: null,
  hoursWorked: null,
  regularHours: null,
  overtimeHours: null,
  hourlyRate: null,
};

export function parsePayStubText(text: string): {
  data: ParsedPayStub;
  confidence: ParseConfidence;
} {
  const lines = toTextLines(text);

  const data: ParsedPayStub = {
    payDate: normalizeDate(
      findLabeledValue(
        lines,
        ['pay date', 'check date', 'payment date', 'advice date', 'date of pay'],
        dateIn,
      ),
    ),
    periodStart: normalizeDate(
      findLabeledValue(
        lines,
        ['pay period start', 'period start', 'period beginning', 'from'],
        dateIn,
      ),
    ),
    periodEnd: normalizeDate(
      findLabeledValue(
        lines,
        ['pay period ending', 'period ending', 'pay period end', 'period end'],
        dateIn,
      ),
    ),
    grossPay: findLabeledValue(
      lines,
      [
        'total gross pay',
        'gross pay',
        'total gross',
        'gross earnings',
        'gross wages',
        'total earnings',
        'gross income',
        'gross',
      ],
      moneyIn,
    ),
    federalTax: findLabeledValue(
      lines,
      [
        'federal income tax',
        'federal withholding',
        'fed income tax',
        'federal tax',
        'fed tax',
        'fed w/h',
        'fed withholding',
        'fed inc tax',
        'fitw',
        'fit w/h',
        'fit',
      ],
      moneyIn,
    ),
    stateTax: findLabeledValue(
      lines,
      [
        'state income tax',
        'state withholding',
        'state tax',
        'state w/h',
        'st income tax',
        'st tax',
        'sitw',
        'sit w/h',
        'sit',
      ],
      moneyIn,
    ),
    socialSecurity: findLabeledValue(
      lines,
      [
        'social security tax',
        'social security',
        'soc sec tax',
        'soc sec',
        'ss tax',
        'ss w/h',
        'fica ss',
        'fica soc sec',
        'oasdi',
      ],
      moneyIn,
    ),
    medicare: findLabeledValue(
      lines,
      ['medicare tax', 'medicare w/h', 'medicare', 'med tax', 'fica med', 'fica medicare'],
      moneyIn,
    ),
    otherDeductionsTotal: findLabeledValue(
      lines,
      [
        'total other deductions',
        'other deductions',
        'other ded',
        'voluntary deductions',
        'post tax deductions',
        'pre tax deductions',
      ],
      moneyIn,
    ),
    netPay: findLabeledValue(
      lines,
      [
        'net pay',
        'net amount',
        'take home pay',
        'take-home pay',
        'net check',
        'net earnings',
        'net deposit',
        'direct deposit amount',
        'check amount',
        'net',
      ],
      moneyIn,
    ),
    hoursWorked: findLabeledValue(
      lines,
      ['total hours worked', 'hours worked', 'total hours', 'total hrs', 'hours'],
      numberIn,
    ),
    regularHours: findLabeledValue(
      lines,
      ['regular hours', 'reg hours', 'reg hrs', 'straight time hours'],
      numberIn,
    ),
    overtimeHours: findLabeledValue(
      lines,
      ['overtime hours', 'ot hours', 'ot hrs', 'o/t hours'],
      numberIn,
    ),
    hourlyRate: findLabeledValue(
      lines,
      ['hourly rate', 'base rate', 'regular rate', 'reg rate', 'rate of pay', 'pay rate', 'rate'],
      numberIn,
    ),
  };

  // "Total deductions" includes the taxes, so it only stands in for the "other"
  // bucket once every tax line has been found and can be subtracted back out.
  if (data.otherDeductionsTotal === null) {
    const totalDeductions = findLabeledValue(
      lines,
      ['total deductions', 'deductions total', 'total dedns'],
      moneyIn,
    );
    const taxes = [data.federalTax, data.stateTax, data.socialSecurity, data.medicare];
    if (totalDeductions !== null && taxes.every((t) => t !== null)) {
      const remainder = totalDeductions - (taxes as number[]).reduce((sum, t) => sum + t, 0);
      if (remainder >= 0) data.otherDeductionsTotal = Math.round(remainder * 100) / 100;
    }
  }

  return { data, confidence: scorePayStub(data) };
}

export function scorePayStub(data: ParsedPayStub): ParseConfidence {
  const fieldsFound = Object.values(data).filter((v) => v !== null && v !== undefined).length;
  const coreFound = [data.grossPay, data.netPay].filter(
    (v) => v !== null && v !== undefined,
  ).length;
  const reasons: string[] = [];

  if (coreFound < 2) reasons.push('Gross pay and net pay could not both be found.');

  // Net above gross means the labels matched the wrong numbers somewhere.
  const sane =
    data.grossPay !== null &&
    data.netPay !== null &&
    data.netPay > 0 &&
    data.netPay <= data.grossPay * 1.05;
  if (coreFound === 2 && !sane) {
    reasons.push(
      'The net pay found is larger than the gross pay, so a label matched the wrong number.',
    );
  }

  return { fieldsFound, coreFound, confident: coreFound === 2 && sane, reasons };
}

/** The fields the review form shows, in the order it shows them. */
export const PAY_STUB_FIELDS: {
  key: keyof ParsedPayStub;
  label: string;
  type: 'text' | 'number';
}[] = [
  { key: 'payDate', label: 'Pay date', type: 'text' },
  { key: 'periodStart', label: 'Period start', type: 'text' },
  { key: 'periodEnd', label: 'Period end', type: 'text' },
  { key: 'grossPay', label: 'Gross pay', type: 'number' },
  { key: 'federalTax', label: 'Federal tax', type: 'number' },
  { key: 'stateTax', label: 'State tax', type: 'number' },
  { key: 'socialSecurity', label: 'Social Security', type: 'number' },
  { key: 'medicare', label: 'Medicare', type: 'number' },
  { key: 'otherDeductionsTotal', label: 'Other deductions', type: 'number' },
  { key: 'netPay', label: 'Net pay', type: 'number' },
  { key: 'hoursWorked', label: 'Hours worked', type: 'number' },
  { key: 'regularHours', label: 'Regular hours', type: 'number' },
  { key: 'overtimeHours', label: 'Overtime hours', type: 'number' },
  { key: 'hourlyRate', label: 'Hourly rate', type: 'number' },
];
