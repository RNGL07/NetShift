/**
 * Example wage profiles.
 *
 * These are *starting points a user can load and then edit*, gathered from
 * publicly reported figures. NetShift is an independent product and is not
 * affiliated with, endorsed by, or sponsored by any employer named here.
 * Every profile carries a `sourceStatus` so nothing in the UI can present
 * community-reported numbers as if they were verified payroll data.
 */

export type WageSourceStatus =
  | 'community_submitted'
  | 'document_reviewed'
  | 'public_source'
  | 'user_custom';

export const WAGE_SOURCE_LABELS: Record<WageSourceStatus, string> = {
  community_submitted: 'Community submitted',
  document_reviewed: 'Document reviewed',
  public_source: 'Public source',
  user_custom: 'Your own figures',
};

export const WAGE_SOURCE_DESCRIPTIONS: Record<WageSourceStatus, string> = {
  community_submitted:
    'Reported by NetShift users. Not verified against any employer document — treat it as a starting point and confirm against your own paperwork.',
  document_reviewed:
    'Transcribed from a wage document a user uploaded. Still unofficial, and may be out of date or specific to one facility.',
  public_source:
    'Taken from publicly reported figures. Unofficial and possibly out of date — confirm against your own paperwork.',
  user_custom: 'Figures you entered yourself. NetShift treats these as authoritative for your account.',
};

export interface ExampleWageStep {
  label: string;
  /** Months of tenure at which this step applies. */
  tenureMonths: number;
  rate: number;
}

export interface ExampleWageProfile {
  key: string;
  employerName: string;
  facility: string | null;
  jobClassification: string;
  sourceStatus: WageSourceStatus;
  effectiveDate: string | null;
  shiftPremium: number;
  teamLeaderPremium: number;
  steps: ExampleWageStep[];
  notes: string;
}

/**
 * Carried over from the prototype's built-in Toyota/TMMTX example data, with
 * the provenance made explicit. The rates were not obtained from the employer.
 */
export const EXAMPLE_WAGE_PROFILES: ExampleWageProfile[] = [
  {
    key: 'tmmtx-skilled',
    employerName: 'Toyota (TMMTX)',
    facility: 'San Antonio, TX',
    jobClassification: 'Skilled Team Member',
    sourceStatus: 'community_submitted',
    effectiveDate: '2026-03-23',
    shiftPremium: 0.8,
    teamLeaderPremium: 2.25,
    steps: [
      { label: 'Start', tenureMonths: 0, rate: 35.9 },
      { label: '6 Months', tenureMonths: 6, rate: 39.15 },
      { label: '1 Year', tenureMonths: 12, rate: 40.61 },
      { label: '1.5 Years', tenureMonths: 18, rate: 42.18 },
      { label: '2 Years', tenureMonths: 24, rate: 43.55 },
      { label: '2.5 Years', tenureMonths: 30, rate: 45.75 },
      { label: '3 Years (Top Rate)', tenureMonths: 36, rate: 47.95 },
    ],
    notes:
      'Community-reported skilled maintenance progression. NetShift is not affiliated with or endorsed by Toyota. Confirm every figure against your own paperwork before relying on it.',
  },
  {
    key: 'tmmtx-production',
    employerName: 'Toyota (TMMTX)',
    facility: 'San Antonio, TX',
    jobClassification: 'Production Team Member',
    sourceStatus: 'community_submitted',
    effectiveDate: '2026-03-23',
    shiftPremium: 0.8,
    teamLeaderPremium: 1.75,
    steps: [
      { label: 'Start', tenureMonths: 0, rate: 23.0 },
      { label: '6 Months', tenureMonths: 6, rate: 25.97 },
      { label: '1 Year', tenureMonths: 12, rate: 26.91 },
      { label: '1.5 Years', tenureMonths: 18, rate: 27.84 },
      { label: '2 Years', tenureMonths: 24, rate: 28.76 },
      { label: '2.5 Years', tenureMonths: 30, rate: 31.55 },
      { label: '3 Years', tenureMonths: 36, rate: 32.47 },
      { label: '3.5 Years', tenureMonths: 42, rate: 34.77 },
      { label: '4 Years (Top Rate)', tenureMonths: 48, rate: 37.11 },
    ],
    notes:
      'Community-reported production progression. NetShift is not affiliated with or endorsed by Toyota. Confirm every figure against your own paperwork before relying on it.',
  },
];

export const EXAMPLE_WAGE_DISCLAIMER =
  'Example wage profiles are unofficial starting points reported by users or taken from public sources. NetShift is an independent product with no affiliation to, or endorsement from, any employer. Always confirm rates against your own paperwork.';
