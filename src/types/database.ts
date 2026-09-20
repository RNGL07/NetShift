/**
 * Row shapes for the Supabase tables.
 *
 * Hand-written rather than generated, so the fields carry the comments that
 * explain what they mean. Column names stay snake_case here to match the
 * database exactly; the service layer maps them to camelCase domain objects,
 * and that mapping is the only place the two conventions meet.
 */

export type PlanTierRow = 'free' | 'pro';
export type ParseSource = 'local' | 'ai' | 'manual';
export type PayFrequencyRow = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
export type ShiftDesignationRow = 'day' | 'evening' | 'night';
export type SundayTreatmentRow = 'regular' | 'ot' | 'double';
export type AuditSeverityRow = 'match' | 'minor' | 'review';

export interface ProfileRow {
  id: string;
  email: string | null;
  display_name: string | null;
  employer_name: string | null;
  facility: string | null;
  job_classification: string | null;
  timezone: string;
  onboarding_completed_at: string | null;
  legacy_import_status: 'pending' | 'imported' | 'skipped' | 'none_found';
  legacy_imported_at: string | null;
  marketing_opt_in: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserPayProfileRow {
  id: string;
  user_id: string;
  name: string;
  is_active: boolean;
  employer_id: string | null;
  location_id: string | null;
  wage_profile_version_id: string | null;
  job_classification: string | null;
  base_rate: number;
  current_step_id: string | null;
  current_step_label: string | null;
  tenure_start_date: string | null;
  shift_premium: number;
  role_premium: number;
  has_role_premium: boolean;
  default_designation: ShiftDesignationRow;
  daily_overtime_threshold: number | null;
  weekly_overtime_threshold: number | null;
  overtime_multiplier: number;
  double_time_multiplier: number;
  sunday_treatment: SundayTreatmentRow;
  holiday_multiplier: number | null;
  per_diem_rate: number;
  per_diem_days_per_week: number;
  pay_frequency: PayFrequencyRow;
  anchor_payday: string | null;
  payday_lag_days: number;
  deduction_pct: number;
  marginal_deduction_pct: number | null;
  ladder_source: ParseSource | null;
  source_status: string;
  created_at: string;
  updated_at: string;
}

export interface UserWageLadderStepRow {
  id: string;
  user_id: string;
  pay_profile_id: string;
  label: string;
  tenure_months: number | null;
  hourly_rate: number;
  sort_order: number;
  is_current: boolean;
}

export interface PayPeriodRow {
  id: string;
  user_id: string;
  pay_profile_id: string | null;
  period_start: string;
  period_end: string;
  payday: string;
  frequency: PayFrequencyRow;
  is_closed: boolean;
  notes: string | null;
}

export interface LoggedShiftRow {
  id: string;
  user_id: string;
  pay_period_id: string | null;
  pay_profile_id: string | null;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  paid_hours: number;
  unpaid_break_minutes: number;
  paid_break_minutes: number;
  designation: ShiftDesignationRow;
  crosses_midnight: boolean;
  is_holiday: boolean;
  rotation_pattern_id: string | null;
  source: 'manual' | 'rotation' | 'import';
  note: string | null;
}

export interface PayStubRow {
  id: string;
  user_id: string;
  pay_period_id: string | null;
  pay_profile_id: string | null;
  pay_date: string | null;
  period_start: string | null;
  period_end: string | null;
  gross_pay: number | null;
  net_pay: number | null;
  hours_worked: number | null;
  regular_hours: number | null;
  overtime_hours: number | null;
  double_time_hours: number | null;
  hourly_rate: number | null;
  federal_tax: number | null;
  state_tax: number | null;
  social_security: number | null;
  medicare: number | null;
  other_deductions_total: number | null;
  shift_differential_amount: number | null;
  sunday_premium_amount: number | null;
  role_premium_amount: number | null;
  per_diem_amount: number | null;
  source: ParseSource;
  confirmed_by_user: boolean;
  document_path: string | null;
  document_deleted_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaycheckAuditRow {
  id: string;
  user_id: string;
  pay_stub_id: string;
  pay_period_id: string | null;
  expected_gross: number;
  actual_gross: number | null;
  gross_difference: number | null;
  expected_regular_hours: number;
  expected_overtime_hours: number;
  expected_double_time_hours: number;
  expected_effective_rate: number | null;
  highest_severity: AuditSeverityRow;
  finding_count: number;
  incomparable_count: number;
  verdict: string;
  reviewed_at: string | null;
  created_at: string;
}

export interface AuditDiscrepancyRow {
  id: string;
  user_id: string;
  audit_id: string;
  kind: string;
  label: string;
  unit: 'money' | 'hours' | 'rate';
  expected_value: number | null;
  actual_value: number | null;
  difference: number | null;
  difference_pct: number | null;
  severity: AuditSeverityRow;
  insufficient_data: boolean;
  message: string;
  sort_order: number;
}

export interface BillRow {
  id: string;
  user_id: string;
  name: string;
  amount: number;
  due_date: string;
  cadence: 'once' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
  end_date: string | null;
  essential: boolean;
  category: string | null;
  archived_at: string | null;
  auto_pay: boolean;
  note: string | null;
}

export interface PaycheckPlanRow {
  id: string;
  user_id: string;
  pay_period_id: string | null;
  payday: string;
  next_payday: string;
  period_start: string | null;
  period_end: string | null;
  frequency: PayFrequencyRow;
  expected_gross: number;
  expected_deductions: number | null;
  deduction_pct: number;
  per_diem: number;
  expected_take_home: number;
  starting_available_balance: number;
  bills_due: number;
  planned_savings: number;
  planned_debt_payments: number;
  safety_buffer: number;
  safe_to_spend: number;
  projected_ending_balance: number;
  is_scenario: boolean;
  scenario_name: string | null;
  branched_from_plan_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanAllocationRow {
  id: string;
  user_id: string;
  plan_id: string;
  kind: 'bill' | 'savings' | 'debt' | 'goal' | 'buffer' | 'other';
  label: string;
  amount: number;
  due_date: string | null;
  essential: boolean;
  paid: boolean;
  paid_at: string | null;
  bill_id: string | null;
  debt_id: string | null;
  goal_id: string | null;
  sort_order: number;
}

export interface GoalRow {
  id: string;
  user_id: string;
  name: string;
  goal_type: string;
  target_amount: number;
  current_amount: number;
  target_date: string | null;
  per_paycheck_contribution: number;
  priority: number;
  completed_at: string | null;
  archived_at: string | null;
  linked_debt_id: string | null;
  note: string | null;
  created_at: string;
}

export interface GoalContributionRow {
  id: string;
  user_id: string;
  goal_id: string;
  amount: number;
  contributed_on: string;
  source: 'manual' | 'paycheck' | 'extra_shift' | 'bonus' | 'transfer';
  pay_period_id: string | null;
  bonus_id: string | null;
  note: string | null;
}

export interface DebtRow {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  balance: number;
  balance_as_of: string;
  original_balance: number | null;
  apr: number;
  minimum_payment: number;
  promo_apr: number | null;
  promo_end_date: string | null;
  due_day_of_month: number | null;
  paid_off_at: string | null;
  note: string | null;
}

export interface DebtPaymentRow {
  id: string;
  user_id: string;
  debt_id: string;
  amount: number;
  principal: number | null;
  interest: number | null;
  paid_on: string;
  balance_after: number | null;
  is_extra: boolean;
  note: string | null;
}

export interface DebtScenarioRow {
  id: string;
  user_id: string;
  name: string;
  strategy: 'snowball' | 'avalanche' | 'as_entered';
  extra_monthly_payment: number;
  one_time_extra_payment: number;
  extra_shifts_per_month: number;
  net_per_extra_shift: number;
  start_date: string;
  months_to_debt_free: number | null;
  total_interest: number | null;
  debt_free_date: string | null;
  computed_at: string | null;
}

export interface BufferSettingsRow {
  user_id: string;
  monthly_essential_expenses: number;
  monthly_total_obligations: number;
  target_months_of_cover: number;
  current_buffer_balance: number;
  held_in: string | null;
}

export interface ShiftScenarioRow {
  id: string;
  user_id: string;
  name: string;
  shift_date: string;
  hours: number | null;
  start_time: string | null;
  end_time: string | null;
  unpaid_break_minutes: number;
  designation: ShiftDesignationRow;
  is_holiday: boolean;
  commute_cost: number;
  meal_cost: number;
  childcare_cost: number;
  other_costs: { id: string; label: string; amount: number }[];
  recurring: boolean;
  recurrences_per_month: number;
  linked_goal_id: string | null;
  linked_debt_id: string | null;
  gross_incremental: number | null;
  net_gain: number | null;
  net_hourly_rate: number | null;
  computed_at: string | null;
}

export interface RotationPatternRow {
  id: string;
  user_id: string;
  name: string;
  pattern_length: number;
  days: unknown[];
  start_date: string;
  end_date: string | null;
  sunday_treatment: SundayTreatmentRow;
  default_start_time: string | null;
  default_end_time: string | null;
  default_unpaid_break_minutes: number;
  default_designation: ShiftDesignationRow;
  is_active: boolean;
}

export interface RotationExceptionRow {
  id: string;
  user_id: string;
  rotation_pattern_id: string;
  exception_date: string;
  kind: 'pto' | 'unpaid_leave' | 'call_in' | 'training' | 'holiday' | 'extra_shift' | 'edited';
  hours: number | null;
  start_time: string | null;
  end_time: string | null;
  designation: ShiftDesignationRow | null;
  paid: boolean | null;
  note: string | null;
}

export interface BonusRow {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  expected_date: string | null;
  conservative_gross: number;
  base_gross: number;
  optimistic_gross: number;
  withholding_pct: number;
  allocate_against: 'conservative' | 'base' | 'optimistic' | 'actual';
  actual_gross: number | null;
  actual_net: number | null;
  received_on: string | null;
  note: string | null;
}

export interface BonusAllocationRow {
  id: string;
  user_id: string;
  bonus_id: string;
  target: 'debt' | 'savings' | 'investment' | 'goal' | 'discretionary';
  label: string;
  percent: number | null;
  amount: number | null;
  linked_goal_id: string | null;
  linked_debt_id: string | null;
  sort_order: number;
}

export interface InvestmentAccountRow {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  balance: number | null;
  institution: string | null;
  sort_order: number;
  archived_at: string | null;
}

export interface HoldingRow {
  id: string;
  user_id: string;
  account_id: string;
  ticker: string;
  name: string | null;
  shares: number;
  cost_basis: number | null;
  manual_price: number | null;
  sort_order: number;
}

export interface MarketReportRow {
  id: string;
  user_id: string;
  generated_at: string;
  as_of: string | null;
  stock_market: string | null;
  stocks_to_watch: { ticker: string; note: string }[];
  housing_market: string | null;
  commodities: string | null;
  model: string | null;
  disclaimer: string;
}

export interface AiExplanationRow {
  id: string;
  user_id: string;
  subject_kind: 'paycheck' | 'audit' | 'plan';
  subject_id: string | null;
  body: string;
  model: string | null;
  created_at: string;
}

export interface EmployerRow {
  id: string;
  name: string;
  slug: string;
  industry: string | null;
  is_example: boolean;
}

export interface WageProfileVersionRow {
  id: string;
  employer_id: string;
  location_id: string | null;
  job_classification: string;
  source_status: 'community_submitted' | 'document_reviewed' | 'public_source' | 'user_custom';
  source_note: string | null;
  effective_from: string;
  effective_to: string | null;
  shift_premium: number;
  role_premium: number;
  role_premium_label: string;
  daily_overtime_threshold: number | null;
  weekly_overtime_threshold: number | null;
  overtime_multiplier: number;
  double_time_multiplier: number;
  sunday_treatment: SundayTreatmentRow;
  holiday_multiplier: number | null;
  per_diem_rate: number | null;
}

export interface WageLadderStepRow {
  id: string;
  wage_profile_version_id: string;
  label: string;
  tenure_months: number;
  hourly_rate: number;
  is_top_rate: boolean;
  sort_order: number;
}

export interface LegacyDataSummaryRow {
  user_id: string;
  key: string;
  value_length: number;
  item_count: number;
  updated_at: string;
}
