/** Display formatters. Every one tolerates `null`/`NaN` and renders an em dash. */

const EM_DASH = '—';

export function fmtMoney(
  value: number | null | undefined,
  options: { compact?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  if (options.compact && Math.abs(value) >= 10_000) {
    return `$${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
  }
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtMoneySigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const formatted = fmtMoney(Math.abs(value));
  return value < 0 ? `−${formatted}` : `+${formatted}`;
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(digits)}%`;
}

export function fmtHours(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toFixed(2);
}

export function fmtRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${fmtMoney(value)}/hr`;
}

export function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtMonths(months: number | null | undefined): string {
  if (months === null || months === undefined || !Number.isFinite(months)) return EM_DASH;
  if (months < 12) return `${Math.round(months)} mo`;
  const years = Math.floor(months / 12);
  const rest = Math.round(months % 12);
  return rest === 0 ? `${years} yr` : `${years} yr ${rest} mo`;
}

/** "3 days ago" / "in 2 weeks", for last-updated stamps. */
export function fmtRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return EM_DASH;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return EM_DASH;
  const diffSeconds = Math.round((then - now.getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds) {
      return formatter.format(Math.round(diffSeconds / seconds), unit);
    }
  }
  return 'just now';
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
