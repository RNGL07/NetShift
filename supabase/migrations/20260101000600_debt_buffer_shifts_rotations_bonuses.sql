-- ---------------------------------------------------------------------------
-- 0006 — Debts, buffer settings, saved shift scenarios, rotations, bonuses.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- debts
-- ---------------------------------------------------------------------------

create table if not exists public.debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind public.debt_kind not null default 'other',
  -- The balance as of `balance_as_of`; payments update both together.
  balance numeric(12, 2) not null check (balance >= 0),
  balance_as_of date not null default current_date,
  original_balance numeric(12, 2) check (original_balance is null or original_balance >= 0),
  apr numeric(6, 3) not null default 0 check (apr >= 0 and apr <= 100),
  minimum_payment numeric(12, 2) not null default 0 check (minimum_payment >= 0),
  promo_apr numeric(6, 3) check (promo_apr is null or (promo_apr >= 0 and promo_apr <= 100)),
  promo_end_date date,
  due_day_of_month integer check (due_day_of_month is null or (due_day_of_month between 1 and 31)),
  paid_off_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A promotional rate without an end date would silently apply forever.
  constraint debts_promo_needs_end_date
    check (promo_apr is null or promo_end_date is not null)
);

comment on table public.debts is 'Debts tracked for payoff planning. Educational tooling, not financial advice.';

create index if not exists debts_user_idx on public.debts (user_id) where paid_off_at is null;

drop trigger if exists debts_set_updated_at on public.debts;
create trigger debts_set_updated_at
  before update on public.debts
  for each row execute function public.set_updated_at();

create table if not exists public.debt_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  debt_id uuid not null references public.debts (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  -- Split recorded when the statement shows it; otherwise null.
  principal numeric(12, 2) check (principal is null or principal >= 0),
  interest numeric(12, 2) check (interest is null or interest >= 0),
  paid_on date not null default current_date,
  balance_after numeric(12, 2) check (balance_after is null or balance_after >= 0),
  is_extra boolean not null default false,
  pay_period_id uuid references public.pay_periods (id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists debt_payments_debt_idx
  on public.debt_payments (debt_id, paid_on desc);

create table if not exists public.debt_payoff_scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  strategy public.payoff_strategy not null default 'avalanche',
  extra_monthly_payment numeric(12, 2) not null default 0 check (extra_monthly_payment >= 0),
  one_time_extra_payment numeric(12, 2) not null default 0 check (one_time_extra_payment >= 0),
  extra_shifts_per_month numeric(5, 2) not null default 0 check (extra_shifts_per_month >= 0),
  net_per_extra_shift numeric(12, 2) not null default 0 check (net_per_extra_shift >= 0),
  start_date date not null default current_date,
  -- Cached results so a saved scenario list does not re-amortise on every load.
  months_to_debt_free integer,
  total_interest numeric(12, 2),
  debt_free_date date,
  computed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists debt_payoff_scenarios_user_idx
  on public.debt_payoff_scenarios (user_id, created_at desc);

drop trigger if exists debt_payoff_scenarios_set_updated_at on public.debt_payoff_scenarios;
create trigger debt_payoff_scenarios_set_updated_at
  before update on public.debt_payoff_scenarios
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Variable-income buffer
-- ---------------------------------------------------------------------------

create table if not exists public.buffer_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  monthly_essential_expenses numeric(12, 2) not null default 0
    check (monthly_essential_expenses >= 0),
  monthly_total_obligations numeric(12, 2) not null default 0
    check (monthly_total_obligations >= 0),
  target_months_of_cover numeric(4, 2) not null default 3
    check (target_months_of_cover > 0 and target_months_of_cover <= 24),
  current_buffer_balance numeric(12, 2) not null default 0
    check (current_buffer_balance >= 0),
  -- Where the buffer is held, for the user's own reference.
  held_in text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists buffer_settings_set_updated_at on public.buffer_settings;
create trigger buffer_settings_set_updated_at
  before update on public.buffer_settings
  for each row execute function public.set_updated_at();

-- A point-in-time record of what the recommendation was, so a user can see
-- the recommendation moving as their history grows.
create table if not exists public.buffer_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  taken_on date not null default current_date,
  sample_size integer not null default 0 check (sample_size >= 0),
  lowest_normal_paycheck numeric(12, 2),
  average_paycheck numeric(12, 2),
  average_base_pay_only_paycheck numeric(12, 2),
  income_variability_pct numeric(6, 2),
  overtime_share_pct numeric(6, 2),
  monthly_income_from_base_pay numeric(12, 2),
  monthly_gap_without_overtime numeric(12, 2),
  obligations_dependent_on_overtime numeric(12, 2),
  overtime_hours_per_month_to_sustain numeric(8, 2),
  recommended_buffer numeric(12, 2) not null default 0,
  confidence text not null default 'none'
    check (confidence in ('none', 'low', 'moderate', 'good')),
  created_at timestamptz not null default now(),
  unique (user_id, taken_on)
);

create index if not exists buffer_snapshots_user_idx
  on public.buffer_snapshots (user_id, taken_on desc);

-- ---------------------------------------------------------------------------
-- Saved shift scenarios
-- ---------------------------------------------------------------------------

create table if not exists public.shift_scenarios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  shift_date date not null,
  hours numeric(6, 2) check (hours is null or (hours > 0 and hours <= 24)),
  start_time time,
  end_time time,
  unpaid_break_minutes integer not null default 0 check (unpaid_break_minutes >= 0),
  designation public.shift_designation not null default 'day',
  is_holiday boolean not null default false,

  commute_cost numeric(10, 2) not null default 0 check (commute_cost >= 0),
  meal_cost numeric(10, 2) not null default 0 check (meal_cost >= 0),
  childcare_cost numeric(10, 2) not null default 0 check (childcare_cost >= 0),
  other_costs jsonb not null default '[]'::jsonb,
  -- Pro: costs that repeat if the shift becomes a standing arrangement.
  recurring boolean not null default false,
  recurrences_per_month numeric(5, 2) not null default 1 check (recurrences_per_month >= 0),

  linked_goal_id uuid references public.goals (id) on delete set null,
  linked_debt_id uuid references public.debts (id) on delete set null,

  -- Cached outcome, recomputed whenever the inputs change.
  gross_incremental numeric(12, 2),
  net_gain numeric(12, 2),
  net_hourly_rate numeric(10, 2),
  computed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shift_scenarios_user_idx
  on public.shift_scenarios (user_id, shift_date desc);

drop trigger if exists shift_scenarios_set_updated_at on public.shift_scenarios;
create trigger shift_scenarios_set_updated_at
  before update on public.shift_scenarios
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Rotation patterns and exceptions
--
-- Only the pattern and the exceptions are stored. Shifts are generated on
-- demand, so changing a rotation does not require rewriting thousands of rows,
-- and a three-year forecast costs nothing in storage.
-- ---------------------------------------------------------------------------

create table if not exists public.rotation_patterns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  pattern_length integer not null check (pattern_length between 1 and 366),
  -- One entry per day of the cycle: working, times, breaks, designation, label.
  days jsonb not null default '[]'::jsonb,
  start_date date not null,
  end_date date,
  sunday_treatment public.sunday_treatment not null default 'regular',
  default_start_time time,
  default_end_time time,
  default_unpaid_break_minutes integer not null default 0
    check (default_unpaid_break_minutes >= 0),
  default_designation public.shift_designation not null default 'day',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rotation_patterns_date_order check (end_date is null or end_date >= start_date),
  constraint rotation_patterns_days_is_array check (jsonb_typeof(days) = 'array')
);

comment on table public.rotation_patterns is
  'A reusable shift rotation. Shifts are generated from this, not materialised into rows.';

create index if not exists rotation_patterns_user_idx
  on public.rotation_patterns (user_id) where is_active;

drop trigger if exists rotation_patterns_set_updated_at on public.rotation_patterns;
create trigger rotation_patterns_set_updated_at
  before update on public.rotation_patterns
  for each row execute function public.set_updated_at();

create table if not exists public.rotation_exceptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  rotation_pattern_id uuid not null
    references public.rotation_patterns (id) on delete cascade,
  exception_date date not null,
  kind public.rotation_exception_kind not null,
  hours numeric(6, 2) check (hours is null or (hours >= 0 and hours <= 24)),
  start_time time,
  end_time time,
  designation public.shift_designation,
  -- Null means "use the default for this kind" (PTO paid, call-in not).
  paid boolean,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One exception per day per pattern, so two edits cannot both apply.
  unique (rotation_pattern_id, exception_date)
);

create index if not exists rotation_exceptions_user_date_idx
  on public.rotation_exceptions (user_id, exception_date);

drop trigger if exists rotation_exceptions_set_updated_at on public.rotation_exceptions;
create trigger rotation_exceptions_set_updated_at
  before update on public.rotation_exceptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Bonuses and profit sharing
-- ---------------------------------------------------------------------------

create table if not exists public.bonuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind public.bonus_kind not null default 'profit_sharing',
  expected_date date,

  conservative_gross numeric(12, 2) not null default 0 check (conservative_gross >= 0),
  base_gross numeric(12, 2) not null default 0 check (base_gross >= 0),
  optimistic_gross numeric(12, 2) not null default 0 check (optimistic_gross >= 0),
  withholding_pct numeric(5, 2) not null default 30
    check (withholding_pct >= 0 and withholding_pct <= 100),
  allocate_against text not null default 'conservative'
    check (allocate_against in ('conservative', 'base', 'optimistic', 'actual')),

  actual_gross numeric(12, 2) check (actual_gross is null or actual_gross >= 0),
  actual_net numeric(12, 2) check (actual_net is null or actual_net >= 0),
  received_on date,

  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A net above gross is never real.
  constraint bonuses_net_not_above_gross
    check (actual_gross is null or actual_net is null or actual_net <= actual_gross)
);

create index if not exists bonuses_user_idx
  on public.bonuses (user_id, expected_date desc nulls last);

drop trigger if exists bonuses_set_updated_at on public.bonuses;
create trigger bonuses_set_updated_at
  before update on public.bonuses
  for each row execute function public.set_updated_at();

create table if not exists public.bonus_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  bonus_id uuid not null references public.bonuses (id) on delete cascade,
  target public.allocation_target not null,
  label text not null,
  -- Exactly one of percent / amount, enforced below.
  percent numeric(6, 3) check (percent is null or (percent >= 0 and percent <= 100)),
  amount numeric(12, 2) check (amount is null or amount >= 0),
  linked_goal_id uuid references public.goals (id) on delete set null,
  linked_debt_id uuid references public.debts (id) on delete set null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bonus_allocations_percent_xor_amount
    check ((percent is null) <> (amount is null))
);

comment on constraint bonus_allocations_percent_xor_amount on public.bonus_allocations is
  'An allocation is either a share of the bonus or a fixed sum, never both and never neither.';

create index if not exists bonus_allocations_bonus_idx
  on public.bonus_allocations (bonus_id, sort_order);

drop trigger if exists bonus_allocations_set_updated_at on public.bonus_allocations;
create trigger bonus_allocations_set_updated_at
  before update on public.bonus_allocations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Deferred foreign keys
--
-- These columns were declared in earlier migrations before their target tables
-- existed; wiring them up here keeps referential integrity without forcing an
-- awkward table ordering.
-- ---------------------------------------------------------------------------

alter table public.paycheck_plan_allocations
  drop constraint if exists paycheck_plan_allocations_debt_id_fkey,
  add constraint paycheck_plan_allocations_debt_id_fkey
    foreign key (debt_id) references public.debts (id) on delete set null;

alter table public.paycheck_plan_allocations
  drop constraint if exists paycheck_plan_allocations_goal_id_fkey,
  add constraint paycheck_plan_allocations_goal_id_fkey
    foreign key (goal_id) references public.goals (id) on delete set null;

alter table public.goals
  drop constraint if exists goals_linked_debt_id_fkey,
  add constraint goals_linked_debt_id_fkey
    foreign key (linked_debt_id) references public.debts (id) on delete set null;

alter table public.goal_contributions
  drop constraint if exists goal_contributions_bonus_id_fkey,
  add constraint goal_contributions_bonus_id_fkey
    foreign key (bonus_id) references public.bonuses (id) on delete set null;

alter table public.logged_shifts
  drop constraint if exists logged_shifts_rotation_pattern_id_fkey,
  add constraint logged_shifts_rotation_pattern_id_fkey
    foreign key (rotation_pattern_id) references public.rotation_patterns (id) on delete set null;

-- ---------------------------------------------------------------------------
-- RLS — owner-only on every table in this migration.
-- ---------------------------------------------------------------------------

alter table public.debts enable row level security;
alter table public.debt_payments enable row level security;
alter table public.debt_payoff_scenarios enable row level security;
alter table public.buffer_settings enable row level security;
alter table public.buffer_snapshots enable row level security;
alter table public.shift_scenarios enable row level security;
alter table public.rotation_patterns enable row level security;
alter table public.rotation_exceptions enable row level security;
alter table public.bonuses enable row level security;
alter table public.bonus_allocations enable row level security;

drop policy if exists "debts: owner all" on public.debts;
create policy "debts: owner all"
  on public.debts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "debt_payments: owner all" on public.debt_payments;
create policy "debt_payments: owner all"
  on public.debt_payments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "debt_payoff_scenarios: owner all" on public.debt_payoff_scenarios;
create policy "debt_payoff_scenarios: owner all"
  on public.debt_payoff_scenarios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "buffer_settings: owner all" on public.buffer_settings;
create policy "buffer_settings: owner all"
  on public.buffer_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "buffer_snapshots: owner all" on public.buffer_snapshots;
create policy "buffer_snapshots: owner all"
  on public.buffer_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "shift_scenarios: owner all" on public.shift_scenarios;
create policy "shift_scenarios: owner all"
  on public.shift_scenarios
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "rotation_patterns: owner all" on public.rotation_patterns;
create policy "rotation_patterns: owner all"
  on public.rotation_patterns
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "rotation_exceptions: owner all" on public.rotation_exceptions;
create policy "rotation_exceptions: owner all"
  on public.rotation_exceptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "bonuses: owner all" on public.bonuses;
create policy "bonuses: owner all"
  on public.bonuses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "bonus_allocations: owner all" on public.bonus_allocations;
create policy "bonus_allocations: owner all"
  on public.bonus_allocations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
