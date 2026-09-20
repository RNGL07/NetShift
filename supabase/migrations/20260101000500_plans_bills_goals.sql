-- ---------------------------------------------------------------------------
-- 0005 — Bills, paycheck plans and their allocations, goals and contributions.
--
-- The structural guard against double-counting lives here: a paycheck plan's
-- bills are *materialised occurrences* keyed by (plan, bill, due date), with a
-- unique constraint. A bill can therefore appear at most once inside one plan,
-- and because a plan's window is half-open [payday, next payday), a bill due on
-- a payday belongs to exactly one plan.
-- ---------------------------------------------------------------------------

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  due_date date not null,
  cadence public.bill_cadence not null default 'monthly',
  end_date date,
  essential boolean not null default true,
  category text,
  -- An archived bill stops generating occurrences but keeps its history.
  archived_at timestamptz,
  auto_pay boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bills_date_order check (end_date is null or end_date >= due_date)
);

comment on table public.bills is
  'Recurring and one-off obligations. Recurring cadences are a Pro feature; the limit is enforced server-side.';

create index if not exists bills_user_idx on public.bills (user_id) where archived_at is null;
create index if not exists bills_user_due_idx on public.bills (user_id, due_date);

drop trigger if exists bills_set_updated_at on public.bills;
create trigger bills_set_updated_at
  before update on public.bills
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- paycheck_plans
-- ---------------------------------------------------------------------------

create table if not exists public.paycheck_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pay_period_id uuid references public.pay_periods (id) on delete set null,

  payday date not null,
  next_payday date not null,
  period_start date,
  period_end date,
  frequency public.pay_frequency not null default 'biweekly',

  expected_gross numeric(12, 2) not null default 0 check (expected_gross >= 0),
  -- Null means "estimate it from the deduction percentage"; a value means the
  -- user knows the real figure, which is what flips confidence to 'confirmed'.
  expected_deductions numeric(12, 2) check (expected_deductions is null or expected_deductions >= 0),
  deduction_pct numeric(5, 2) not null default 25
    check (deduction_pct >= 0 and deduction_pct <= 100),
  per_diem numeric(12, 2) not null default 0 check (per_diem >= 0),
  expected_take_home numeric(12, 2) not null default 0,

  starting_available_balance numeric(12, 2) not null default 0,
  bills_due numeric(12, 2) not null default 0 check (bills_due >= 0),
  planned_savings numeric(12, 2) not null default 0 check (planned_savings >= 0),
  planned_debt_payments numeric(12, 2) not null default 0 check (planned_debt_payments >= 0),
  safety_buffer numeric(12, 2) not null default 0 check (safety_buffer >= 0),
  safe_to_spend numeric(12, 2) not null default 0,
  projected_ending_balance numeric(12, 2) not null default 0,

  -- A saved "what if" rather than the live plan for this payday. Pro only.
  is_scenario boolean not null default false,
  scenario_name text,
  -- The plan this scenario was branched from, for comparison.
  branched_from_plan_id uuid references public.paycheck_plans (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint paycheck_plans_window check (next_payday > payday),
  constraint paycheck_plans_scenario_named
    check (not is_scenario or scenario_name is not null)
);

comment on table public.paycheck_plans is
  'One payday-to-payday plan. The window is half-open [payday, next_payday) so bills land in exactly one plan.';

-- At most one live (non-scenario) plan per payday. Scenarios are exempt so a
-- user can compare several versions of the same payday.
create unique index if not exists paycheck_plans_one_live_per_payday
  on public.paycheck_plans (user_id, payday) where not is_scenario;

create index if not exists paycheck_plans_user_payday_idx
  on public.paycheck_plans (user_id, payday desc);

drop trigger if exists paycheck_plans_set_updated_at on public.paycheck_plans;
create trigger paycheck_plans_set_updated_at
  before update on public.paycheck_plans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- paycheck_plan_allocations
--
-- Every claim on a paycheck: a bill occurrence, a savings transfer, a debt
-- payment, or a manual set-aside. Storing them as rows (rather than as the
-- three summary columns alone) is what lets the UI show where the money went
-- and lets the plan be rebuilt without re-deriving bill dates.
-- ---------------------------------------------------------------------------

create table if not exists public.paycheck_plan_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_id uuid not null references public.paycheck_plans (id) on delete cascade,
  kind text not null check (kind in ('bill', 'savings', 'debt', 'goal', 'buffer', 'other')),
  label text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  due_date date,
  essential boolean not null default false,
  paid boolean not null default false,
  paid_at timestamptz,

  bill_id uuid references public.bills (id) on delete set null,
  debt_id uuid,
  goal_id uuid,

  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.paycheck_plan_allocations is
  'Individual claims on one paycheck. The unique index below is the double-counting guard.';

-- The double-counting guard: one occurrence of a given bill, on a given due
-- date, inside a given plan. A second insert of the same occurrence fails.
create unique index if not exists paycheck_plan_allocations_one_bill_occurrence
  on public.paycheck_plan_allocations (plan_id, bill_id, due_date)
  where bill_id is not null;

create index if not exists paycheck_plan_allocations_plan_idx
  on public.paycheck_plan_allocations (plan_id, sort_order);

drop trigger if exists paycheck_plan_allocations_set_updated_at on public.paycheck_plan_allocations;
create trigger paycheck_plan_allocations_set_updated_at
  before update on public.paycheck_plan_allocations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- goals and contributions
-- ---------------------------------------------------------------------------

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  goal_type public.goal_type not null default 'custom',
  target_amount numeric(12, 2) not null check (target_amount >= 0),
  -- Denormalised sum of contributions, kept in step by the trigger below.
  current_amount numeric(12, 2) not null default 0,
  target_date date,
  per_paycheck_contribution numeric(12, 2) not null default 0
    check (per_paycheck_contribution >= 0),
  priority integer not null default 0,
  -- Set when the goal is reached or abandoned; frees a free-tier goal slot.
  completed_at timestamptz,
  archived_at timestamptz,
  linked_debt_id uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.goals is
  'Savings goals. Free tier allows one active goal; the limit is enforced server-side.';

create index if not exists goals_user_active_idx
  on public.goals (user_id, priority)
  where completed_at is null and archived_at is null;

drop trigger if exists goals_set_updated_at on public.goals;
create trigger goals_set_updated_at
  before update on public.goals
  for each row execute function public.set_updated_at();

create table if not exists public.goal_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null references public.goals (id) on delete cascade,
  amount numeric(12, 2) not null,
  contributed_on date not null default current_date,
  -- Where the money came from, for the "funded by overtime" narrative.
  source text not null default 'manual'
    check (source in ('manual', 'paycheck', 'extra_shift', 'bonus', 'transfer')),
  pay_period_id uuid references public.pay_periods (id) on delete set null,
  bonus_id uuid,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists goal_contributions_goal_idx
  on public.goal_contributions (goal_id, contributed_on desc);

-- ---------------------------------------------------------------------------
-- Keeping goals.current_amount honest
--
-- Recomputing the whole sum on every change (rather than adding a delta) means
-- the denormalised total cannot drift out of step with the contribution rows,
-- which is the usual failure of a running-total column.
-- ---------------------------------------------------------------------------

create or replace function public.recalculate_goal_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_goal_id uuid := coalesce(new.goal_id, old.goal_id);
begin
  update public.goals g
     set current_amount = coalesce(
           (select sum(c.amount) from public.goal_contributions c where c.goal_id = v_goal_id),
           0
         ),
         updated_at = now()
   where g.id = v_goal_id;
  return null;
end;
$$;

drop trigger if exists goal_contributions_recalculate on public.goal_contributions;
create trigger goal_contributions_recalculate
  after insert or update or delete on public.goal_contributions
  for each row execute function public.recalculate_goal_total();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.bills enable row level security;
alter table public.paycheck_plans enable row level security;
alter table public.paycheck_plan_allocations enable row level security;
alter table public.goals enable row level security;
alter table public.goal_contributions enable row level security;

drop policy if exists "bills: owner all" on public.bills;
create policy "bills: owner all"
  on public.bills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "paycheck_plans: owner all" on public.paycheck_plans;
create policy "paycheck_plans: owner all"
  on public.paycheck_plans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "paycheck_plan_allocations: owner all" on public.paycheck_plan_allocations;
create policy "paycheck_plan_allocations: owner all"
  on public.paycheck_plan_allocations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "goals: owner all" on public.goals;
create policy "goals: owner all"
  on public.goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "goal_contributions: owner all" on public.goal_contributions;
create policy "goal_contributions: owner all"
  on public.goal_contributions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
