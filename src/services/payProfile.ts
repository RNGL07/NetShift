/**
 * Pay-profile data access.
 *
 * The service layer is where snake_case database rows become camelCase domain
 * objects, and where a row's loose numeric columns become the strongly-typed
 * `OvertimeRules` and `RatePremiums` the calculators expect. Doing that
 * conversion once, here, is what keeps every feature from re-deriving it.
 */

import { supabase } from '@/lib/supabase/client';
import type { UserPayProfileRow, UserWageLadderStepRow } from '@/types/database';
import {
  DEFAULT_OVERTIME_RULES,
  type OvertimeRules,
  type PayPeriodKind,
  type RatePremiums,
  type ShiftDesignation,
} from '@/lib/calc/hours';

export interface WageStep {
  id: string;
  label: string;
  tenureMonths: number | null;
  hourlyRate: number;
  sortOrder: number;
  isCurrent: boolean;
}

export interface PayProfile {
  id: string;
  name: string;
  isActive: boolean;
  employerId: string | null;
  jobClassification: string | null;
  baseRate: number;
  currentStepLabel: string | null;
  tenureStartDate: string | null;
  premiums: RatePremiums;
  defaultDesignation: ShiftDesignation;
  rules: OvertimeRules;
  holidayMultiplier: number | null;
  perDiemRate: number;
  perDiemDaysPerWeek: number;
  payFrequency: PayPeriodKind;
  anchorPayday: string | null;
  paydayLagDays: number;
  deductionPct: number;
  /**
   * Withholding applied to *extra* earnings. Falls back to the average rate
   * when the user has not set one, and can be cleared back to that default by
   * writing null.
   */
  marginalDeductionPct: number;
  ladderSource: 'local' | 'ai' | 'manual' | null;
  steps: WageStep[];
}

/** A usable profile for a brand-new account, so nothing is ever undefined. */
export const DEFAULT_PAY_PROFILE: Omit<PayProfile, 'id'> = {
  name: 'My pay profile',
  isActive: true,
  employerId: null,
  jobClassification: null,
  baseRate: 0,
  currentStepLabel: null,
  tenureStartDate: null,
  premiums: { shiftPremium: 0, rolePremium: 0, hasRolePremium: false },
  defaultDesignation: 'day',
  rules: DEFAULT_OVERTIME_RULES,
  holidayMultiplier: null,
  perDiemRate: 0,
  perDiemDaysPerWeek: 0,
  payFrequency: 'biweekly',
  anchorPayday: null,
  paydayLagDays: 5,
  deductionPct: 25,
  marginalDeductionPct: 25,
  ladderSource: null,
  steps: [],
};

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function mapPayProfile(row: UserPayProfileRow, steps: UserWageLadderStepRow[]): PayProfile {
  const deductionPct = toNumber(row.deduction_pct, 25);
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    employerId: row.employer_id,
    jobClassification: row.job_classification,
    baseRate: toNumber(row.base_rate),
    currentStepLabel: row.current_step_label,
    tenureStartDate: row.tenure_start_date,
    premiums: {
      shiftPremium: toNumber(row.shift_premium),
      rolePremium: toNumber(row.role_premium),
      hasRolePremium: row.has_role_premium,
    },
    defaultDesignation: row.default_designation,
    rules: {
      dailyThreshold:
        row.daily_overtime_threshold === null ? null : toNumber(row.daily_overtime_threshold, 8),
      weeklyThreshold:
        row.weekly_overtime_threshold === null ? null : toNumber(row.weekly_overtime_threshold, 40),
      sundayTreatment: row.sunday_treatment,
      overtimeMultiplier: toNumber(row.overtime_multiplier, 1.5),
      doubleTimeMultiplier: toNumber(row.double_time_multiplier, 2),
    },
    holidayMultiplier: row.holiday_multiplier === null ? null : toNumber(row.holiday_multiplier),
    perDiemRate: toNumber(row.per_diem_rate),
    perDiemDaysPerWeek: toNumber(row.per_diem_days_per_week),
    payFrequency: row.pay_frequency,
    anchorPayday: row.anchor_payday,
    paydayLagDays: toNumber(row.payday_lag_days, 5),
    deductionPct,
    // Marginal withholding defaults to the average rate when unknown. It is
    // usually higher in reality, and the UI says so where it matters.
    marginalDeductionPct:
      row.marginal_deduction_pct === null ? deductionPct : toNumber(row.marginal_deduction_pct),
    ladderSource: row.ladder_source,
    steps: steps
      .map((step) => ({
        id: step.id,
        label: step.label,
        tenureMonths: step.tenure_months,
        hourlyRate: toNumber(step.hourly_rate),
        sortOrder: step.sort_order,
        isCurrent: step.is_current,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

export async function listPayProfiles(userId: string): Promise<PayProfile[]> {
  const { data: profiles, error } = await supabase
    .from('user_pay_profiles')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  if (!profiles || profiles.length === 0) return [];

  const { data: steps } = await supabase
    .from('user_wage_ladder_steps')
    .select('*')
    .eq('user_id', userId);

  const stepsByProfile = new Map<string, UserWageLadderStepRow[]>();
  for (const step of (steps ?? []) as UserWageLadderStepRow[]) {
    const list = stepsByProfile.get(step.pay_profile_id) ?? [];
    list.push(step);
    stepsByProfile.set(step.pay_profile_id, list);
  }

  return (profiles as UserPayProfileRow[]).map((row) =>
    mapPayProfile(row, stepsByProfile.get(row.id) ?? []),
  );
}

export async function createPayProfile(
  userId: string,
  patch: PayProfilePatch = {},
): Promise<PayProfile> {
  const { data, error } = await supabase
    .from('user_pay_profiles')
    .insert({
      user_id: userId,
      name: patch.name ?? DEFAULT_PAY_PROFILE.name,
      base_rate: patch.baseRate ?? 0,
      pay_frequency: patch.payFrequency ?? 'biweekly',
      deduction_pct: patch.deductionPct ?? 25,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapPayProfile(data as UserPayProfileRow, []);
}

/** Maps a domain patch back onto database columns. */
export type PayProfilePatch = Partial<Omit<PayProfile, 'marginalDeductionPct'>> & {
  /** `null` clears the override so the average deduction rate is used again. */
  marginalDeductionPct?: number | null;
};

export function toPayProfileRow(patch: PayProfilePatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  if (patch.employerId !== undefined) row.employer_id = patch.employerId;
  if (patch.jobClassification !== undefined) row.job_classification = patch.jobClassification;
  if (patch.baseRate !== undefined) row.base_rate = patch.baseRate;
  if (patch.currentStepLabel !== undefined) row.current_step_label = patch.currentStepLabel;
  if (patch.tenureStartDate !== undefined) row.tenure_start_date = patch.tenureStartDate;
  if (patch.premiums) {
    row.shift_premium = patch.premiums.shiftPremium;
    row.role_premium = patch.premiums.rolePremium;
    row.has_role_premium = patch.premiums.hasRolePremium;
  }
  if (patch.defaultDesignation !== undefined) row.default_designation = patch.defaultDesignation;
  if (patch.rules) {
    row.daily_overtime_threshold = patch.rules.dailyThreshold;
    row.weekly_overtime_threshold = patch.rules.weeklyThreshold;
    row.sunday_treatment = patch.rules.sundayTreatment;
    row.overtime_multiplier = patch.rules.overtimeMultiplier;
    row.double_time_multiplier = patch.rules.doubleTimeMultiplier;
  }
  if (patch.holidayMultiplier !== undefined) row.holiday_multiplier = patch.holidayMultiplier;
  if (patch.perDiemRate !== undefined) row.per_diem_rate = patch.perDiemRate;
  if (patch.perDiemDaysPerWeek !== undefined) row.per_diem_days_per_week = patch.perDiemDaysPerWeek;
  if (patch.payFrequency !== undefined) row.pay_frequency = patch.payFrequency;
  if (patch.anchorPayday !== undefined) row.anchor_payday = patch.anchorPayday;
  if (patch.paydayLagDays !== undefined) row.payday_lag_days = patch.paydayLagDays;
  if (patch.deductionPct !== undefined) row.deduction_pct = patch.deductionPct;
  if (patch.marginalDeductionPct !== undefined) {
    row.marginal_deduction_pct = patch.marginalDeductionPct;
  }
  if (patch.ladderSource !== undefined) row.ladder_source = patch.ladderSource;
  return row;
}

export async function updatePayProfile(id: string, patch: PayProfilePatch): Promise<void> {
  const row = toPayProfileRow(patch);
  if (Object.keys(row).length === 0) return;
  const { error } = await supabase.from('user_pay_profiles').update(row).eq('id', id);
  if (error) throw error;
}

export async function deletePayProfile(id: string): Promise<void> {
  const { error } = await supabase.from('user_pay_profiles').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Replaces a profile's wage ladder wholesale.
 *
 * Delete-then-insert rather than a diff: a ladder is a handful of rows that
 * always arrive together (from a parse or a template), and reconciling them
 * individually would add failure modes for no benefit.
 */
export async function replaceLadder(
  userId: string,
  payProfileId: string,
  steps: { label: string; hourlyRate: number; tenureMonths?: number | null; isCurrent?: boolean }[],
): Promise<void> {
  const { error: deleteError } = await supabase
    .from('user_wage_ladder_steps')
    .delete()
    .eq('pay_profile_id', payProfileId);
  if (deleteError) throw deleteError;

  if (steps.length === 0) return;

  const { error } = await supabase.from('user_wage_ladder_steps').insert(
    steps.map((step, index) => ({
      user_id: userId,
      pay_profile_id: payProfileId,
      label: step.label,
      tenure_months: step.tenureMonths ?? null,
      hourly_rate: step.hourlyRate,
      sort_order: index,
      is_current: step.isCurrent ?? false,
    })),
  );
  if (error) throw error;
}

export async function setCurrentStep(payProfileId: string, stepId: string | null): Promise<void> {
  // Clear the flag across the ladder first so exactly one step is ever current.
  const { error: clearError } = await supabase
    .from('user_wage_ladder_steps')
    .update({ is_current: false })
    .eq('pay_profile_id', payProfileId);
  if (clearError) throw clearError;

  if (!stepId) return;
  const { error } = await supabase
    .from('user_wage_ladder_steps')
    .update({ is_current: true })
    .eq('id', stepId);
  if (error) throw error;
}
