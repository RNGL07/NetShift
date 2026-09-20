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

/**
 * Sanity-checks a locally parsed stub, clearing any field that cannot be right.
 *
 * This runs the same cross-field checks the server applies to AI output. It has
 * to, because a stub read in the browser never reaches the server — so without
 * these, a misread would be pre-filled into the save form, marked confident,
 * and very likely accepted.
 *
 * The specific misread this exists for: on a stub whose earnings are printed
 * as a table, the column header reads "Rate  Hours  This Period", and the
 * first number on the row beneath it is the RATE. Matching the word "Hours"
 * and taking the next number yields the hourly rate as the hours worked — a
 * figure that looks plausible and quietly corrupts every overtime calculation,
 * audit, and buffer estimate built on it.
 *
 * Mutates `data` in place and returns the reasons anything was cleared.
 */
function applySanityChecks(data: ParsedPayStub): string[] {
  const reasons: string[] = [];

  // Hours that equal the hourly rate are the table-header misread above.
  if (
    data.hoursWorked !== null &&
    data.hourlyRate !== null &&
    Math.abs(data.hoursWorked - data.hourlyRate) < 0.005
  ) {
    reasons.push('Hours worked and the hourly rate came out identical, so the hours were cleared.');
    data.hoursWorked = null;
  }

  // An hourly rate and a period's hours each have a plausible band of their
  // own. Checking those FIRST means the obvious misread — a rate of 4061 from
  // "$40.61" with a lost decimal point — is caught on its own terms, without
  // needing to arbitrate between two fields.
  const PLAUSIBLE_RATE = { min: 1, max: 200 };
  const PLAUSIBLE_HOURS = { min: 0.25, max: 400 };

  if (
    data.hourlyRate !== null &&
    (data.hourlyRate < PLAUSIBLE_RATE.min || data.hourlyRate > PLAUSIBLE_RATE.max)
  ) {
    reasons.push('The hourly rate found is outside a believable range, so it was cleared.');
    data.hourlyRate = null;
  }

  if (
    data.hoursWorked !== null &&
    (data.hoursWorked < PLAUSIBLE_HOURS.min || data.hoursWorked > PLAUSIBLE_HOURS.max)
  ) {
    reasons.push('The hours found are outside a believable range, so they were cleared.');
    data.hoursWorked = null;
  }

  // Both are individually believable but disagree with the cheque. Gross is the
  // most reliably labelled figure on a stub, so it arbitrates: whichever of
  // hours-or-rate can be derived plausibly from gross is the one that survives.
  // Clearing the good field instead would lose real data and leave the bad one
  // in place.
  if (data.hoursWorked !== null && data.hourlyRate !== null && data.grossPay) {
    const impliedRate = data.hoursWorked > 0 ? data.grossPay / data.hoursWorked : 0;
    const impliedHours = data.hourlyRate > 0 ? data.grossPay / data.hourlyRate : 0;

    // Overtime lifts the true average rate above base, so this band is wide:
    // it looks for an order-of-magnitude error, not a rounding one.
    const consistent =
      impliedRate > 0 && data.hourlyRate <= impliedRate * 5 && data.hourlyRate >= impliedRate / 5;

    if (!consistent) {
      const hoursLookRight = impliedRate >= PLAUSIBLE_RATE.min && impliedRate <= PLAUSIBLE_RATE.max;
      const rateLooksRight =
        impliedHours >= PLAUSIBLE_HOURS.min && impliedHours <= PLAUSIBLE_HOURS.max;

      if (hoursLookRight && !rateLooksRight) {
        reasons.push(
          'The hourly rate does not fit the gross pay and hours shown, so it was cleared.',
        );
        data.hourlyRate = null;
      } else if (rateLooksRight && !hoursLookRight) {
        reasons.push(
          'The hours found do not fit the gross pay and rate shown, so they were cleared.',
        );
        data.hoursWorked = null;
      } else {
        // Neither derivation is clearly right, so nothing is cleared — but the
        // disagreement is surfaced for the user to resolve in the review form.
        reasons.push(
          'Hours, hourly rate and gross pay do not agree with each other — please check all three.',
        );
      }
    }
  }

  // A period that ends before it starts means two dates were swapped.
  if (data.periodStart !== null && data.periodEnd !== null && data.periodStart > data.periodEnd) {
    reasons.push('The pay period ended before it started, so both dates were cleared.');
    data.periodStart = null;
    data.periodEnd = null;
  }

  // Broken-out hours that do not add up to the stated total mean one of them
  // was read from a year-to-date column.
  const brokenOut = [data.regularHours, data.overtimeHours].filter((h): h is number => h !== null);
  if (data.hoursWorked !== null && brokenOut.length > 0) {
    const sum = brokenOut.reduce((total, h) => total + h, 0);
    if (sum > 0 && Math.abs(sum - data.hoursWorked) > 1) {
      reasons.push('Regular and overtime hours do not add up to the total shown — please confirm.');
    }
  }

  return reasons;
}

export function scorePayStub(data: ParsedPayStub): ParseConfidence {
  // Clear impossible values before counting, so a cleared field is not
  // reported as found.
  const sanityReasons = applySanityChecks(data);
  const fieldsFound = Object.values(data).filter((v) => v !== null && v !== undefined).length;
  const coreFound = [data.grossPay, data.netPay].filter(
    (v) => v !== null && v !== undefined,
  ).length;
  const reasons: string[] = [...sanityReasons];

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
