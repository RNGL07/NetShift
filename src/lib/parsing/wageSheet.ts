/**
 * Local (free, in-browser) wage-sheet parsing.
 *
 * Employer wage profiles are NetShift's differentiator, so getting a wage sheet
 * in with as little typing as possible matters. Same principle as the pay-stub
 * parser: read the PDF's text layer locally first, and only fall back to the
 * server-side AI path for photos and scans.
 */

import {
  LOCAL_DATE_RE,
  dateIn,
  findLabeledValue,
  normalizeDate,
  parseLocalNumber,
  premiumIn,
  textIn,
  toTextLines,
} from './text';

export interface ParsedWageStep {
  label: string;
  rate: number;
}

export interface ParsedWageSheet {
  trackLabel: string | null;
  effectiveDate: string | null;
  shiftPremium: number | null;
  teamLeaderPremium: number | null;
  steps: ParsedWageStep[];
}

export interface WageSheetConfidence {
  stepsFound: number;
  fieldsFound: number;
  confident: boolean;
  reasons: string[];
}

// Longest-first inside each unit group: regex alternation is ordered, so
// `mos?` placed before `months?` would match "6 Months" as just "6 Mo" and
// truncate every label on a column-layout sheet.
const STEP_LABEL_CORE =
  '(?:start(?:ing)?(?:\\s*rate)?|hire(?:\\s*in)?(?:\\s*rate)?|probation(?:ary)?|top(?:\\s*(?:rate|out))?|max(?:imum)?(?:\\s*rate)?|final(?:\\s*rate)?|step\\s*\\d+|level\\s*\\d+|tier\\s*\\d+|\\d+(?:\\.\\d+)?\\s*\\+?\\s*(?:months?|mos?|years?|yrs?|weeks?|wks?|days?))';
const STEP_LABEL_ANCHORED = new RegExp(`^\\s*${STEP_LABEL_CORE}\\b`, 'i');
const STEP_LABEL_ANYWHERE = new RegExp(`(?:^|[^a-z0-9])${STEP_LABEL_CORE}\\b`, 'i');

function collectRateSteps(lines: readonly string[], labelRe: RegExp): ParsedWageStep[] {
  const steps: ParsedWageStep[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const match = labelRe.exec(line);
    if (!match) continue;
    const rest = line.slice(match.index + match[0].length);
    const rateMatch = rest.match(/\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*\.\d{1,2}/);
    if (!rateMatch) continue;
    const rate = parseLocalNumber(rateMatch[0]);
    // Plausible hourly rates only — this keeps years, counts, and percentages out.
    if (rate === null || rate < 1 || rate > 500) continue;
    const cutAt = line.length - rest.length + rest.indexOf(rateMatch[0]);
    const label =
      line
        .slice(0, cutAt)
        .replace(/[\s:\-–—.]+$/, '')
        .trim() || match[0].trim();
    const key = `${label.toLowerCase()}|${rate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({ label, rate });
  }

  return steps;
}

/**
 * A money-shaped number: `$`-prefixed, or written with exactly two decimals.
 *
 * The two-decimal requirement is what separates a rate from a tenure figure.
 * On a header row reading "Start 6 Months 1 Year 1.5 Years", the "1.5" is a
 * number in a plausible hourly range — requiring cents is what stops it being
 * read as a wage of $1.50.
 */
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*\.\d{2}\b/g;

/** Every step label on a line, in the order they appear. */
function extractStepLabels(line: string): string[] {
  const re = new RegExp(STEP_LABEL_CORE, 'gi');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const label = match[0].trim();
    if (label) out.push(label);
    if (out.length > 30) break;
  }
  return out;
}

/** Every plausible hourly rate on a line, in the order they appear. */
function extractRates(line: string): number[] {
  const out: number[] = [];
  for (const raw of line.match(MONEY_RE) ?? []) {
    const value = parseLocalNumber(raw);
    if (value !== null && value >= 1 && value <= 500) out.push(value);
  }
  return out;
}

/**
 * Reads a wage table laid out in COLUMNS rather than rows.
 *
 * This is how almost every real wage progression sheet is printed, and how
 * pdf.js emits it — the milestone labels run across a header row and the rates
 * across the row beneath:
 *
 *   Classification   Start   6 Months   1 Year   2 Years
 *   Skilled TM       35.90     39.15     40.61     43.55
 *
 * The row-wise collector cannot see this, because no line contains both a
 * label and its rate. Labels and rates are paired positionally from the END of
 * each row, so a leading "Classification" or "Skilled TM" cell in either row
 * does not shift the alignment.
 */
function collectTabularSteps(lines: readonly string[]): ParsedWageStep[] {
  for (let i = 0; i < lines.length; i++) {
    const labels = extractStepLabels(lines[i]);
    if (labels.length < 2) continue;

    // The rates usually sit on the next line, but a wrapped header or a units
    // row can push them down one or two.
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const rates = extractRates(lines[j]);
      if (rates.length < 2) continue;

      const count = Math.min(labels.length, rates.length);
      const labelTail = labels.slice(labels.length - count);
      const rateTail = rates.slice(rates.length - count);

      const steps: ParsedWageStep[] = [];
      const seen = new Set<string>();
      for (let k = 0; k < count; k++) {
        const key = `${labelTail[k].toLowerCase()}|${rateTail[k]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        steps.push({ label: labelTail[k], rate: rateTail[k] });
      }

      // A real progression climbs. If these do not, the two rows were not a
      // label/rate pair and pairing them would invent a wage ladder.
      const ascending = steps.every(
        (step, index) => index === 0 || step.rate >= steps[index - 1].rate,
      );
      if (steps.length >= 2 && ascending) return steps;
    }
  }
  return [];
}

export function parseWageSheetText(text: string): {
  data: ParsedWageSheet;
  confidence: WageSheetConfidence;
} {
  const lines = toTextLines(text);

  // Three layouts, tried in order of how trustworthy the match is.
  //
  // 1. Row-wise, anchored: each tenure step starts its own line. Least
  //    ambiguous, so it wins outright when it finds a ladder.
  // 2. Column-wise: labels in a header row, rates in the row beneath. This is
  //    how most printed wage sheets are laid out, and the row-wise collector
  //    cannot see it at all.
  // 3. Row-wise, unanchored: the same as (1) but allowing the track name to
  //    precede the step label. Loosest, so it goes last.
  let steps = collectRateSteps(lines, STEP_LABEL_ANCHORED);
  if (steps.length < 2) {
    const tabular = collectTabularSteps(lines);
    if (tabular.length > steps.length) steps = tabular;
  }
  if (steps.length < 2) {
    const loose = collectRateSteps(lines, STEP_LABEL_ANYWHERE);
    if (loose.length > steps.length) steps = loose;
  }

  let trackLabel = findLabeledValue(
    lines,
    [
      'job classification',
      'classification',
      'job title',
      'position',
      'pay track',
      'wage group',
      'pay grade',
      'job group',
      'track',
      'role',
    ],
    textIn,
  );

  if (!trackLabel) {
    // Fall back to a heading that names a job track. An effective date often
    // rides along on that same line, so drop it before checking for numbers —
    // any other digits mean the line is a rate row, not a heading.
    const heading = lines
      .map((line) =>
        line
          .replace(LOCAL_DATE_RE, ' ')
          .replace(/\s+/g, ' ')
          .replace(/[\s:\-–—]*\b(?:eff(?:ective)?\.?(?:\s*date)?|as of)\s*$/i, '')
          .trim(),
      )
      .find(
        (line) =>
          /team member|team leader|technician|operator|associate|maintenance|production|skilled|apprentice|journeyman/i.test(
            line,
          ) && !/\d/.test(line),
      );
    if (heading) trackLabel = heading.slice(0, 80);
  }

  const data: ParsedWageSheet = {
    trackLabel,
    effectiveDate: normalizeDate(
      findLabeledValue(
        lines,
        ['effective date', 'effective as of', 'eff date', 'effective', 'in effect'],
        dateIn,
      ),
    ),
    shiftPremium: findLabeledValue(
      lines,
      [
        'shift premium',
        'shift differential',
        'shift diff',
        'off shift premium',
        'night premium',
        'night differential',
        'second shift',
        'third shift',
      ],
      premiumIn,
    ),
    teamLeaderPremium: findLabeledValue(
      lines,
      [
        'team leader premium',
        'team lead premium',
        'group leader premium',
        'crew leader premium',
        'leader premium',
        'lead premium',
        'lead differential',
        'team leader',
        'team lead',
        'group leader',
      ],
      premiumIn,
    ),
    steps,
  };

  const fieldsFound = (
    ['trackLabel', 'effectiveDate', 'shiftPremium', 'teamLeaderPremium'] as const
  ).filter((key) => data[key] !== null && data[key] !== undefined).length;

  return {
    data,
    confidence: {
      stepsFound: steps.length,
      fieldsFound,
      confident: steps.length >= 2,
      reasons:
        steps.length < 2 ? ['Fewer than two wage steps were found in the document text.'] : [],
    },
  };
}
