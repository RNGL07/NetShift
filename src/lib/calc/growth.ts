/**
 * Compound-growth projection for the investments tab.
 *
 * Kept from the prototype unchanged in behaviour: monthly compounding, a
 * contribution at the end of each month (an ordinary annuity), and an explicit
 * zero-rate branch because the annuity formula divides by the rate.
 */

import { num, roundMoney } from './money';

export interface GrowthInput {
  startingBalance: number;
  monthlyContribution: number;
  /** Annual return, as a percentage. */
  annualReturnPct: number;
  years: number;
}

export interface GrowthResult {
  futureValue: number;
  totalContributed: number;
  totalGrowth: number;
  years: number;
  annualReturnPct: number;
  /** Year-end balances, for a chart or table. */
  byYear: { year: number; balance: number; contributed: number }[];
}

export function projectGrowth(input: GrowthInput): GrowthResult | null {
  const start = num(input.startingBalance, 0);
  const monthly = num(input.monthlyContribution, 0);
  const annualPct = num(input.annualReturnPct, Number.NaN);
  const years = num(input.years, 0);

  if (!Number.isFinite(annualPct) || years <= 0) return null;

  const monthlyRate = annualPct / 100 / 12;
  const months = Math.round(years * 12);

  const futureValue =
    monthlyRate === 0
      ? start + monthly * months
      : start * (1 + monthlyRate) ** months +
        monthly * (((1 + monthlyRate) ** months - 1) / monthlyRate);

  const byYear: GrowthResult['byYear'] = [];
  for (let year = 1; year <= Math.ceil(years); year++) {
    const m = Math.min(months, year * 12);
    const balance =
      monthlyRate === 0
        ? start + monthly * m
        : start * (1 + monthlyRate) ** m + monthly * (((1 + monthlyRate) ** m - 1) / monthlyRate);
    byYear.push({ year, balance: roundMoney(balance), contributed: roundMoney(start + monthly * m) });
  }

  const totalContributed = roundMoney(start + monthly * months);

  return {
    futureValue: roundMoney(futureValue),
    totalContributed,
    totalGrowth: roundMoney(futureValue - totalContributed),
    years,
    annualReturnPct: annualPct,
    byYear,
  };
}
