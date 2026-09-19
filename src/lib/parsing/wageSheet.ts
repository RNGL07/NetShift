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

const STEP_LABEL_CORE =
  '(?:start(?:ing)?(?:\\s*rate)?|hire(?:\\s*in)?(?:\\s*rate)?|probation(?:ary)?|top(?:\\s*(?:rate|out))?|max(?:imum)?(?:\\s*rate)?|final(?:\\s*rate)?|step\\s*\\d+|level\\s*\\d+|tier\\s*\\d+|\\d+(?:\\.\\d+)?\\s*\\+?\\s*(?:mos?|months?|yrs?|years?|wks?|weeks?|days?))';
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
    const label = line.slice(0, cutAt).replace(/[\s:\-–—.]+$/, '').trim() || match[0].trim();
    const key = `${label.toLowerCase()}|${rate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({ label, rate });
  }

  return steps;
}

export function parseWageSheetText(text: string): {
  data: ParsedWageSheet;
  confidence: WageSheetConfidence;
} {
  const lines = toTextLines(text);

  // Most wage sheets list each tenure step at the start of its own row; some
  // prefix the row with the track name, so retry unanchored if the strict pass
  // came up short.
  let steps = collectRateSteps(lines, STEP_LABEL_ANCHORED);
  if (steps.length < 2) {
    const loose = collectRateSteps(lines, STEP_LABEL_ANYWHERE);
    if (loose.length > steps.length) steps = loose;
  }

  let trackLabel = findLabeledValue(
    lines,
    ['job classification', 'classification', 'job title', 'position', 'pay track', 'wage group', 'pay grade', 'job group', 'track', 'role'],
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
      findLabeledValue(lines, ['effective date', 'effective as of', 'eff date', 'effective', 'in effect'], dateIn),
    ),
    shiftPremium: findLabeledValue(
      lines,
      ['shift premium', 'shift differential', 'shift diff', 'off shift premium', 'night premium', 'night differential', 'second shift', 'third shift'],
      premiumIn,
    ),
    teamLeaderPremium: findLabeledValue(
      lines,
      ['team leader premium', 'team lead premium', 'group leader premium', 'crew leader premium', 'leader premium', 'lead premium', 'lead differential', 'team leader', 'team lead', 'group leader'],
      premiumIn,
    ),
    steps,
  };

  const fieldsFound = (['trackLabel', 'effectiveDate', 'shiftPremium', 'teamLeaderPremium'] as const).filter(
    (key) => data[key] !== null && data[key] !== undefined,
  ).length;

  return {
    data,
    confidence: {
      stepsFound: steps.length,
      fieldsFound,
      confident: steps.length >= 2,
      reasons: steps.length < 2 ? ['Fewer than two wage steps were found in the document text.'] : [],
    },
  };
}
