-- ---------------------------------------------------------------------------
-- 0000 — Extensions, shared enums, and helper functions.
--
-- Everything in NetShift's schema is owned by exactly one user, so this
-- migration establishes the two things every later table depends on: a
-- consistent `updated_at` trigger, and the enum vocabulary the domain uses.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at is
  'Trigger function that stamps updated_at on every UPDATE.';

-- ---------------------------------------------------------------------------
-- Enums
--
-- Enums rather than check constraints, so that adding a value is a deliberate
-- migration and the application''s TypeScript unions stay in step with the
-- database.
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.plan_tier as enum ('free', 'pro');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.subscription_status as enum (
    'active', 'trialing', 'past_due', 'canceled', 'unpaid',
    'incomplete', 'incomplete_expired', 'paused', 'none'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.pay_frequency as enum ('weekly', 'biweekly', 'semimonthly', 'monthly');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.shift_designation as enum ('day', 'evening', 'night');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sunday_treatment as enum ('regular', 'ot', 'double');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.wage_source_status as enum (
    'community_submitted', 'document_reviewed', 'public_source', 'user_custom'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_operation as enum (
    'parse_paystub', 'parse_wage_sheet', 'explain_paycheck', 'market_report'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.parse_source as enum ('local', 'ai', 'manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.goal_type as enum (
    'emergency_fund', 'debt', 'vacation', 'down_payment',
    'vehicle_repair', 'retirement_contribution', 'custom'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.debt_kind as enum (
    'credit_card', 'auto', 'student', 'personal', 'mortgage', 'medical', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payoff_strategy as enum ('snowball', 'avalanche', 'as_entered');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.bill_cadence as enum (
    'once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annual'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.rotation_exception_kind as enum (
    'pto', 'unpaid_leave', 'call_in', 'training', 'holiday', 'extra_shift', 'edited'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.bonus_kind as enum (
    'profit_sharing', 'annual_bonus', 'referral', 'retention', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.allocation_target as enum (
    'debt', 'savings', 'investment', 'goal', 'discretionary'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.investment_account_kind as enum (
    'traditional_401k', 'roth_401k', 'traditional_ira', 'roth_ira',
    'brokerage', 'hsa', 'cash', 'custom'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.audit_severity as enum ('match', 'minor', 'review');
exception when duplicate_object then null; end $$;
