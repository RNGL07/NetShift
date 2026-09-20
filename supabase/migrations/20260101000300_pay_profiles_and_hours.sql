-- ---------------------------------------------------------------------------
-- 0003 — The user's own pay profile, pay periods, and logged hours.
--
-- From here on every table is user-owned and follows the same pattern:
--   user_id uuid not null references auth.users on delete cascade
--   + an owner-only policy for each of select/insert/update/delete
-- so that cross-user access is impossible even if the application forgets a
-- filter. The `with check` on insert/update is what stops a user writing a row
-- attributed to somebody else.
-- ---------------------------------------------------------------------------

create table if not exists public.user_pay_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'My pay profile',
  is_active boolean not null default true,

  -- Optional link to a shared wage profile. Null when fully hand-entered.
  employer_id uuid references public.employers (id) on delete set null,
  location_id uuid references public.employer_locations (id) on delete set null,
  wage_profile_version_id uuid references public.wage_profile_versions (id) on delete set null,
  job_classification text,

  -- The user's own figures always win over the shared profile's.
  base_rate numeric(10, 4) not null default 0 check (base_rate >= 0),
  current_step_id uuid references public.wage_ladder_steps (id) on delete set null,
  current_step_label text,
  tenure_start_date date,

  shift_premium numeric(10, 4) not null default 0 check (shift_premium >= 0),
  role_premium numeric(10, 4) not null default 0 check (role_premium >= 0),
  has_role_premium boolean not null default false,
  default_designation public.shift_designation not null default 'day',

  daily_overtime_threshold numeric(6, 2) default 8
    check (daily_overtime_threshold is null or daily_overtime_threshold > 0),
  weekly_overtime_threshold numeric(6, 2) default 40
    check (weekly_overtime_threshold is null or weekly_overtime_threshold > 0),
  overtime_multiplier numeric(5, 3) not null default 1.5 check (overtime_multiplier >= 1),
  double_time_multiplier numeric(5, 3) not null default 2 check (double_time_multiplier >= 1),
  sunday_treatment public.sunday_treatment not null default 'regular',
  holiday_multiplier numeric(5, 3) check (holiday_multiplier is null or holiday_multiplier >= 1),

  per_diem_rate numeric(10, 2) not null default 0 check (per_diem_rate >= 0),
  per_diem_days_per_week numeric(4, 2) not null default 0
    check (per_diem_days_per_week >= 0 and per_diem_days_per_week <= 7),

  pay_frequency public.pay_frequency not null default 'biweekly',
  -- A known payday, from which the whole payday series is generated.
  anchor_payday date,
  -- Days between the end of a pay period and its payday.
  payday_lag_days integer not null default 5 check (payday_lag_days >= 0 and payday_lag_days <= 60),

  -- The user's own average withholding, learned from their stubs.
  deduction_pct numeric(5, 2) not null default 25
    check (deduction_pct >= 0 and deduction_pct <= 100),
  -- Marginal rate applied to *extra* earnings, which is usually higher.
  marginal_deduction_pct numeric(5, 2)
    check (marginal_deduction_pct is null or (marginal_deduction_pct >= 0 and marginal_deduction_pct <= 100)),

  -- Where the ladder came from, so the UI can label it honestly.
  ladder_source public.parse_source,
  source_status public.wage_source_status not null default 'user_custom',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_pay_profiles is
  'A user''s own pay setup. Free tier allows one active profile; the limit is enforced server-side.';

create index if not exists user_pay_profiles_user_idx on public.user_pay_profiles (user_id);
-- At most one active profile per user is *not* enforced here, because Pro
-- users may keep several and switch between them; the active flag is advisory
-- and the plan limit is checked in the service layer.
create index if not exists user_pay_profiles_active_idx
  on public.user_pay_profiles (user_id) where is_active;

drop trigger if exists user_pay_profiles_set_updated_at on public.user_pay_profiles;
create trigger user_pay_profiles_set_updated_at
  before update on public.user_pay_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- user_wage_ladder_steps — a hand-built or overridden ladder
-- ---------------------------------------------------------------------------

create table if not exists public.user_wage_ladder_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pay_profile_id uuid not null references public.user_pay_profiles (id) on delete cascade,
  label text not null,
  tenure_months integer check (tenure_months is null or tenure_months >= 0),
  hourly_rate numeric(10, 4) not null check (hourly_rate >= 0),
  sort_order integer not null default 0,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_wage_ladder_steps_profile_idx
  on public.user_wage_ladder_steps (pay_profile_id, sort_order);

drop trigger if exists user_wage_ladder_steps_set_updated_at on public.user_wage_ladder_steps;
create trigger user_wage_ladder_steps_set_updated_at
  before update on public.user_wage_ladder_steps
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- pay_periods
--
-- The spine of the whole application: hours, stubs, audits, and plans all hang
-- off a pay period. `period_start`/`period_end` are the work window; `payday`
-- is when the money arrives, which is usually a week later.
-- ---------------------------------------------------------------------------

create table if not exists public.pay_periods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pay_profile_id uuid references public.user_pay_profiles (id) on delete set null,
  period_start date not null,
  period_end date not null,
  payday date not null,
  frequency public.pay_frequency not null default 'biweekly',
  -- Set once a stub for this period has been reconciled.
  is_closed boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pay_periods_date_order check (period_end >= period_start),
  -- A user cannot have two pay periods starting on the same day.
  unique (user_id, period_start)
);

comment on table public.pay_periods is 'One work period and the payday it is paid on.';

create index if not exists pay_periods_user_payday_idx
  on public.pay_periods (user_id, payday desc);
create index if not exists pay_periods_user_range_idx
  on public.pay_periods (user_id, period_start, period_end);

drop trigger if exists pay_periods_set_updated_at on public.pay_periods;
create trigger pay_periods_set_updated_at
  before update on public.pay_periods
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- logged_shifts — one row per worked day
--
-- Hours are stored per calendar day rather than per week, because a pay period
-- does not align with a week and a cross-midnight shift has to be attributed to
-- exactly one day (its start date — see SHIFT_DAY_ATTRIBUTION).
-- ---------------------------------------------------------------------------

create table if not exists public.logged_shifts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pay_period_id uuid references public.pay_periods (id) on delete set null,
  pay_profile_id uuid references public.user_pay_profiles (id) on delete set null,
  work_date date not null,
  start_time time,
  end_time time,
  -- Authoritative when start/end are absent; otherwise derived and stored so
  -- queries never have to recompute a cross-midnight span.
  paid_hours numeric(6, 2) not null default 0 check (paid_hours >= 0 and paid_hours <= 24),
  unpaid_break_minutes integer not null default 0 check (unpaid_break_minutes >= 0),
  paid_break_minutes integer not null default 0 check (paid_break_minutes >= 0),
  designation public.shift_designation not null default 'day',
  crosses_midnight boolean not null default false,
  is_holiday boolean not null default false,
  -- Populated when the day came from a rotation rather than manual entry.
  rotation_pattern_id uuid,
  source text not null default 'manual' check (source in ('manual', 'rotation', 'import')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One logged entry per day. A double-back gets its hours summed into one row.
  unique (user_id, work_date)
);

comment on table public.logged_shifts is
  'Daily hours. A shift that crosses midnight is attributed entirely to its start date.';

create index if not exists logged_shifts_user_date_idx
  on public.logged_shifts (user_id, work_date desc);
create index if not exists logged_shifts_period_idx
  on public.logged_shifts (pay_period_id);

drop trigger if exists logged_shifts_set_updated_at on public.logged_shifts;
create trigger logged_shifts_set_updated_at
  before update on public.logged_shifts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Owner-only RLS for all four tables.
-- ---------------------------------------------------------------------------

alter table public.user_pay_profiles enable row level security;
alter table public.user_wage_ladder_steps enable row level security;
alter table public.pay_periods enable row level security;
alter table public.logged_shifts enable row level security;

drop policy if exists "user_pay_profiles: owner all" on public.user_pay_profiles;
create policy "user_pay_profiles: owner all"
  on public.user_pay_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_wage_ladder_steps: owner all" on public.user_wage_ladder_steps;
create policy "user_wage_ladder_steps: owner all"
  on public.user_wage_ladder_steps
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "pay_periods: owner all" on public.pay_periods;
create policy "pay_periods: owner all"
  on public.pay_periods
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "logged_shifts: owner all" on public.logged_shifts;
create policy "logged_shifts: owner all"
  on public.logged_shifts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
