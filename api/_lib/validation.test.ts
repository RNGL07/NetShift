import { describe, expect, it } from 'vitest';
import { validateMarketReport, validatePayStub, validateWageSheet } from './validation';

describe('validatePayStub — coercion', () => {
  it('accepts a clean extraction unchanged', () => {
    const { value, issues } = validatePayStub({
      pay_date: '2026-03-06',
      gross_pay: 4391.44,
      net_pay: 3143.19,
      hours_worked: 92.5,
      hourly_rate: 40.61,
    });
    expect(value.grossPay).toBe(4391.44);
    expect(value.netPay).toBe(3143.19);
    expect(value.payDate).toBe('2026-03-06');
    expect(issues).toHaveLength(0);
  });

  it('strips currency formatting a model left in', () => {
    const { value } = validatePayStub({ gross_pay: '$4,391.44', net_pay: '3,143.19' });
    expect(value.grossPay).toBe(4391.44);
    expect(value.netPay).toBe(3143.19);
  });

  it('normalises the date formats stubs actually use', () => {
    expect(validatePayStub({ pay_date: '03/06/2026' }).value.payDate).toBe('2026-03-06');
    expect(validatePayStub({ pay_date: 'Mar 6, 2026' }).value.payDate).toBe('2026-03-06');
    expect(validatePayStub({ pay_date: '3/6/26' }).value.payDate).toBe('2026-03-06');
  });

  it('nulls a value that is not a number rather than storing NaN', () => {
    const { value, issues } = validatePayStub({ gross_pay: 'see attached' });
    expect(value.grossPay).toBeNull();
    expect(issues.some((i) => i.field === 'gross pay')).toBe(true);
  });

  it('treats absent fields as null without raising an issue', () => {
    const { value, issues } = validatePayStub({});
    expect(value.grossPay).toBeNull();
    expect(issues).toHaveLength(0);
  });
});

describe('validatePayStub — range checks', () => {
  it('rejects an implausible paycheck', () => {
    const { value, issues } = validatePayStub({ gross_pay: 50_000_000 });
    expect(value.grossPay).toBeNull();
    expect(issues[0].message).toContain('plausible range');
  });

  it('rejects negative money', () => {
    expect(validatePayStub({ gross_pay: -500 }).value.grossPay).toBeNull();
  });

  it('rejects more hours than a month contains', () => {
    expect(validatePayStub({ hours_worked: 5000 }).value.hoursWorked).toBeNull();
  });

  it('rejects a date outside a plausible range', () => {
    expect(validatePayStub({ pay_date: '1965-01-01' }).value.payDate).toBeNull();
    expect(validatePayStub({ pay_date: '2150-01-01' }).value.payDate).toBeNull();
  });
});

describe('validatePayStub — cross-field checks', () => {
  it('drops a net above gross, which is always a misread', () => {
    const { value, issues } = validatePayStub({ gross_pay: 1000, net_pay: 9999 });
    expect(value.grossPay).toBe(1000);
    expect(value.netPay).toBeNull();
    expect(issues.some((i) => i.message.includes('higher than gross'))).toBe(true);
  });

  it('allows net slightly above gross, which rounding can produce', () => {
    expect(validatePayStub({ gross_pay: 1000, net_pay: 1002 }).value.netPay).toBe(1002);
  });

  it('clears a pay period that ends before it starts', () => {
    const { value, issues } = validatePayStub({
      period_start: '2026-03-15',
      period_end: '2026-03-01',
    });
    expect(value.periodStart).toBeNull();
    expect(value.periodEnd).toBeNull();
    expect(issues.some((i) => i.field === 'pay period')).toBe(true);
  });

  it('flags hour categories that do not add up to the total', () => {
    const { issues } = validatePayStub({
      hours_worked: 92.5,
      regular_hours: 80,
      overtime_hours: 40, // 120 total — the "total" was a YTD figure
    });
    expect(issues.some((i) => i.field === 'hours')).toBe(true);
  });

  it('accepts hour categories that add up within rounding', () => {
    const { issues } = validatePayStub({
      hours_worked: 92.5,
      regular_hours: 80,
      overtime_hours: 12.5,
    });
    expect(issues.some((i) => i.field === 'hours')).toBe(false);
  });

  it('drops a rate that contradicts the gross and hours shown', () => {
    // $4,061/hr from "$40.61" with a lost decimal point.
    const { value, issues } = validatePayStub({
      gross_pay: 3248.8,
      hours_worked: 80,
      hourly_rate: 4061,
    });
    expect(value.hourlyRate).toBeNull();
    expect(issues.some((i) => i.field === 'hourly rate')).toBe(true);
  });

  it('keeps a rate consistent with gross and hours', () => {
    const { value } = validatePayStub({
      gross_pay: 3248.8,
      hours_worked: 80,
      hourly_rate: 40.61,
    });
    expect(value.hourlyRate).toBe(40.61);
  });

  it('keeps a rate that differs because of overtime, within the tolerance', () => {
    // Overtime lifts the implied average well above base, but not fivefold.
    const { value } = validatePayStub({
      gross_pay: 4391.44,
      hours_worked: 92.5,
      hourly_rate: 40.61,
    });
    expect(value.hourlyRate).toBe(40.61);
  });
});

describe('validateWageSheet', () => {
  it('keeps plausible steps and sorts them ascending', () => {
    const { value } = validateWageSheet({
      track_label: 'Skilled Team Member',
      effective_date: '03/23/2026',
      steps: [
        { label: '1 Year', rate: 40.61 },
        { label: 'Start', rate: 35.9 },
        { label: 'Top', rate: 47.95 },
      ],
    });
    expect(value.steps.map((s) => s.rate)).toEqual([35.9, 40.61, 47.95]);
    expect(value.effectiveDate).toBe('2026-03-23');
    expect(value.trackLabel).toBe('Skilled Team Member');
  });

  it('drops steps whose rate is not a plausible hourly figure', () => {
    const { value } = validateWageSheet({
      steps: [
        { label: 'Start', rate: 35.9 },
        { label: 'Annual', rate: 74_672 },
        { label: 'Bad', rate: 'n/a' },
      ],
    });
    expect(value.steps).toHaveLength(1);
  });

  it('rejects a premium that is clearly not per-hour', () => {
    const { value } = validateWageSheet({ shift_premium: 1600, team_leader_premium: 2.25 });
    expect(value.shiftPremium).toBeNull();
    expect(value.teamLeaderPremium).toBe(2.25);
  });

  it('caps an implausibly long ladder', () => {
    const steps = Array.from({ length: 60 }, (_, i) => ({ label: `S${i}`, rate: 20 + i * 0.1 }));
    const { value, issues } = validateWageSheet({ steps });
    expect(value.steps).toHaveLength(40);
    expect(issues.some((i) => i.field === 'steps')).toBe(true);
  });

  it('handles a response with no steps at all', () => {
    const { value } = validateWageSheet({ track_label: 'Something' });
    expect(value.steps).toEqual([]);
  });

  it('gives an unlabelled step a fallback label', () => {
    const { value } = validateWageSheet({ steps: [{ rate: 35.9 }] });
    expect(value.steps[0].label).toBe('Step 1');
  });

  it('tolerates a completely malformed payload', () => {
    expect(() => validateWageSheet(null)).not.toThrow();
    expect(() => validateWageSheet({ steps: 'nope' })).not.toThrow();
    expect(validateWageSheet({ steps: 'nope' }).value.steps).toEqual([]);
  });
});

describe('validateMarketReport', () => {
  it('keeps well-formed entries and upper-cases tickers', () => {
    const { value } = validateMarketReport({
      as_of: 'March 6, 2026 close',
      stock_market: 'Indices finished higher.',
      stocks_to_watch: [{ ticker: 'voo', note: 'Broad-market ETF in focus.' }],
      housing_market: 'Rates eased slightly.',
      commodities: 'Gold steady.',
    });
    expect(value.stocksToWatch).toEqual([{ ticker: 'VOO', note: 'Broad-market ETF in focus.' }]);
    expect(value.stockMarket).toContain('higher');
  });

  it('drops entries that are not real ticker shapes', () => {
    const { value } = validateMarketReport({
      stocks_to_watch: [
        { ticker: 'VOO', note: 'ok' },
        { ticker: 'not a ticker at all', note: 'x' },
        { ticker: 'AAPL' }, // no note
      ],
    });
    expect(value.stocksToWatch.map((s) => s.ticker)).toEqual(['VOO']);
  });

  it('caps the watch list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ticker: `AA${i}`, note: 'x' }));
    expect(
      validateMarketReport({ stocks_to_watch: many }).value.stocksToWatch.length,
    ).toBeLessThanOrEqual(10);
  });

  it('tolerates a malformed payload', () => {
    expect(() => validateMarketReport(null)).not.toThrow();
    expect(validateMarketReport({ stocks_to_watch: 'nope' }).value.stocksToWatch).toEqual([]);
  });
});
