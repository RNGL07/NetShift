/**
 * Validation of model output before it becomes a financial record.
 *
 * A model can return a number where a null belongs, a net above a gross, or a
 * rate of 4061 because it read "$40.61" without the decimal. None of that
 * should ever reach the database: a wrong stored figure silently corrupts
 * every audit, plan, and buffer calculation downstream, and the user has no
 * way to tell it came from a misread.
 *
 * So everything the model returns is coerced, range-checked, and
 * cross-checked, and anything that fails is dropped to null rather than
 * guessed at — a missing field is visibly missing in the review form, while a
 * plausible-looking wrong one is not.
 */

export interface FieldIssue {
  field: string;
  message: string;
}

export interface ValidationResult<T> {
  value: T;
  issues: FieldIssue[];
}

/** Coerces to a finite number within a range, or null. */
export function boundedNumber(
  raw: unknown,
  options: { min: number; max: number; field: string; issues: FieldIssue[] },
): number | null {
  if (raw === null || raw === undefined || raw === '') return null;

  const parsed = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(parsed)) {
    options.issues.push({
      field: options.field,
      message: 'was not a number and has been left blank',
    });
    return null;
  }
  if (parsed < options.min || parsed > options.max) {
    options.issues.push({
      field: options.field,
      message: `was outside the plausible range and has been left blank`,
    });
    return null;
  }
  return Math.round(parsed * 10_000) / 10_000;
}

/** Accepts `YYYY-MM-DD`, `MM/DD/YYYY`, and `Mon D, YYYY`; returns ISO or null. */
export function isoDate(raw: unknown, field: string, issues: FieldIssue[]): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = String(raw).trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) return pad(Number(iso[1]), Number(iso[2]), Number(iso[3]), field, issues);

  const slash = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value);
  if (slash) {
    let year = Number(slash[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return pad(year, Number(slash[1]), Number(slash[2]), field, issues);
  }

  const named = /^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(value);
  if (named) {
    const months = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ];
    const index = months.indexOf(named[1].slice(0, 3).toLowerCase());
    if (index >= 0) return pad(Number(named[3]), index + 1, Number(named[2]), field, issues);
  }

  issues.push({ field, message: 'was not a date NetShift could read and has been left blank' });
  return null;
}

function pad(
  year: number,
  month: number,
  day: number,
  field: string,
  issues: FieldIssue[],
): string | null {
  // A pay stub from 1970 or 2200 is a misread, not a date.
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    issues.push({ field, message: 'was not a plausible date and has been left blank' });
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function shortText(raw: unknown, maxLength = 120): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Pay stub
// ---------------------------------------------------------------------------

export interface ValidatedPayStub {
  payDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  grossPay: number | null;
  netPay: number | null;
  hoursWorked: number | null;
  regularHours: number | null;
  overtimeHours: number | null;
  doubleTimeHours: number | null;
  hourlyRate: number | null;
  federalTax: number | null;
  stateTax: number | null;
  socialSecurity: number | null;
  medicare: number | null;
  otherDeductionsTotal: number | null;
  shiftDifferentialAmount: number | null;
  sundayPremiumAmount: number | null;
  rolePremiumAmount: number | null;
  perDiemAmount: number | null;
}

// A single pay period. Nobody is paid $2M on one stub, and nobody works more
// than 24×31 hours in one; figures beyond these are misreads.
const MAX_MONEY = 2_000_000;
const MAX_HOURS = 744;
const MAX_RATE = 2_000;

export function validatePayStub(raw: unknown): ValidationResult<ValidatedPayStub> {
  const issues: FieldIssue[] = [];
  const input = (raw ?? {}) as Record<string, unknown>;
  const money = (key: string, field: string) =>
    boundedNumber(input[key], { min: 0, max: MAX_MONEY, field, issues });

  const value: ValidatedPayStub = {
    payDate: isoDate(input.pay_date, 'pay date', issues),
    periodStart: isoDate(input.period_start, 'period start', issues),
    periodEnd: isoDate(input.period_end, 'period end', issues),
    grossPay: money('gross_pay', 'gross pay'),
    netPay: money('net_pay', 'net pay'),
    hoursWorked: boundedNumber(input.hours_worked, {
      min: 0,
      max: MAX_HOURS,
      field: 'hours worked',
      issues,
    }),
    regularHours: boundedNumber(input.regular_hours, {
      min: 0,
      max: MAX_HOURS,
      field: 'regular hours',
      issues,
    }),
    overtimeHours: boundedNumber(input.overtime_hours, {
      min: 0,
      max: MAX_HOURS,
      field: 'overtime hours',
      issues,
    }),
    doubleTimeHours: boundedNumber(input.double_time_hours, {
      min: 0,
      max: MAX_HOURS,
      field: 'double-time hours',
      issues,
    }),
    hourlyRate: boundedNumber(input.hourly_rate, {
      min: 0,
      max: MAX_RATE,
      field: 'hourly rate',
      issues,
    }),
    federalTax: money('federal_tax', 'federal tax'),
    stateTax: money('state_tax', 'state tax'),
    socialSecurity: money('social_security', 'Social Security'),
    medicare: money('medicare', 'Medicare'),
    otherDeductionsTotal: money('other_deductions_total', 'other deductions'),
    shiftDifferentialAmount: money('shift_differential_amount', 'shift differential'),
    sundayPremiumAmount: money('sunday_premium_amount', 'Sunday premium'),
    rolePremiumAmount: money('role_premium_amount', 'role premium'),
    perDiemAmount: money('per_diem_amount', 'per diem'),
  };

  // --- Cross-field checks -------------------------------------------------
  //
  // These catch the misreads that individually look plausible. Each one drops
  // the *less* trustworthy field rather than silently keeping an impossible
  // pair, because the review form can then show it as missing.

  if (value.grossPay !== null && value.netPay !== null && value.netPay > value.grossPay * 1.05) {
    issues.push({
      field: 'net pay',
      message:
        'came out higher than gross pay, which means a label was misread — please check both',
    });
    value.netPay = null;
  }

  if (
    value.periodStart !== null &&
    value.periodEnd !== null &&
    value.periodStart > value.periodEnd
  ) {
    issues.push({
      field: 'pay period',
      message: 'started after it ended, so the dates were cleared',
    });
    value.periodStart = null;
    value.periodEnd = null;
  }

  const brokenOut = [value.regularHours, value.overtimeHours, value.doubleTimeHours].filter(
    (h): h is number => h !== null,
  );
  if (value.hoursWorked !== null && brokenOut.length > 0) {
    const sum = brokenOut.reduce((total, h) => total + h, 0);
    // A gap larger than an hour means the parts and the total are not the same
    // figure — often the total was read from a year-to-date column.
    if (Math.abs(sum - value.hoursWorked) > 1 && sum > 0) {
      issues.push({
        field: 'hours',
        message: 'the hour categories do not add up to the total shown — please confirm them',
      });
    }
  }

  if (value.hourlyRate !== null && value.grossPay !== null && value.hoursWorked) {
    const implied = value.grossPay / value.hoursWorked;
    // A rate off by more than 5× from the implied one is a decimal-point error.
    if (implied > 0 && (value.hourlyRate > implied * 5 || value.hourlyRate < implied / 5)) {
      issues.push({
        field: 'hourly rate',
        message: 'does not line up with the gross and hours shown, so it was left blank',
      });
      value.hourlyRate = null;
    }
  }

  return { value, issues };
}

// ---------------------------------------------------------------------------
// Wage sheet
// ---------------------------------------------------------------------------

export interface ValidatedWageStep {
  label: string;
  rate: number;
}

export interface ValidatedWageSheet {
  trackLabel: string | null;
  effectiveDate: string | null;
  shiftPremium: number | null;
  teamLeaderPremium: number | null;
  steps: ValidatedWageStep[];
}

export function validateWageSheet(raw: unknown): ValidationResult<ValidatedWageSheet> {
  const issues: FieldIssue[] = [];
  const input = (raw ?? {}) as Record<string, unknown>;

  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  const steps: ValidatedWageStep[] = [];

  for (const [index, entry] of rawSteps.entries()) {
    const step = (entry ?? {}) as Record<string, unknown>;
    const rate = boundedNumber(step.rate, {
      min: 1,
      max: MAX_RATE,
      field: `step ${index + 1} rate`,
      issues,
    });
    if (rate === null) continue;
    steps.push({ label: shortText(step.label, 60) ?? `Step ${index + 1}`, rate });
  }

  // A ladder that goes down is a mis-ordered read, not a pay cut. Sorting
  // ascending is safe and matches how every wage sheet is actually laid out.
  steps.sort((a, b) => a.rate - b.rate);

  if (steps.length > 40) {
    issues.push({
      field: 'steps',
      message: 'had more entries than a wage ladder plausibly has; only the first 40 were kept',
    });
    steps.length = 40;
  }

  const value: ValidatedWageSheet = {
    trackLabel: shortText(input.track_label, 80),
    effectiveDate: isoDate(input.effective_date, 'effective date', issues),
    // A per-hour premium above $50 is a misread of a weekly or annual figure.
    shiftPremium: boundedNumber(input.shift_premium, {
      min: 0,
      max: 50,
      field: 'shift premium',
      issues,
    }),
    teamLeaderPremium: boundedNumber(input.team_leader_premium, {
      min: 0,
      max: 50,
      field: 'team leader premium',
      issues,
    }),
    steps,
  };

  return { value, issues };
}

// ---------------------------------------------------------------------------
// Market report
// ---------------------------------------------------------------------------

export interface ValidatedMarketReport {
  asOf: string | null;
  stockMarket: string | null;
  stocksToWatch: { ticker: string; note: string }[];
  housingMarket: string | null;
  commodities: string | null;
}

export function validateMarketReport(raw: unknown): ValidationResult<ValidatedMarketReport> {
  const issues: FieldIssue[] = [];
  const input = (raw ?? {}) as Record<string, unknown>;

  const watchRaw = Array.isArray(input.stocks_to_watch) ? input.stocks_to_watch : [];
  const stocksToWatch = watchRaw
    .slice(0, 10)
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const ticker = shortText(item.ticker, 12);
      const note = shortText(item.note, 400);
      // A ticker is letters and at most a dot; anything else is not a symbol.
      if (!ticker || !/^[A-Za-z.-]{1,10}$/.test(ticker) || !note) return null;
      return { ticker: ticker.toUpperCase(), note };
    })
    .filter((entry): entry is { ticker: string; note: string } => entry !== null);

  return {
    value: {
      asOf: shortText(input.as_of, 80),
      stockMarket: shortText(input.stock_market, 2000),
      stocksToWatch,
      housingMarket: shortText(input.housing_market, 2000),
      commodities: shortText(input.commodities, 2000),
    },
    issues,
  };
}
