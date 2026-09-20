-- ---------------------------------------------------------------------------
-- 0004 — Parsed pay stubs, their line items, and paycheck audits.
--
-- Pay stubs are the most sensitive data NetShift holds. Three deliberate
-- choices follow from that:
--   1. The *document* is not stored here — only the numbers read from it. The
--      file lives in a private Storage bucket and is deleted after extraction
--      unless the user opts to keep it (see migration 0008).
--   2. No raw extracted text is retained.
--   3. Line items are normalised into earnings / deductions / taxes so a
--      line-level reconciliation is a join, not a JSON scan.
-- ---------------------------------------------------------------------------

create table if not exists public.pay_stubs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pay_period_id uuid references public.pay_periods (id) on delete set null,
  pay_profile_id uuid references public.user_pay_profiles (id) on delete set null,

  pay_date date,
  period_start date,
  period_end date,

  gross_pay numeric(12, 2) check (gross_pay is null or gross_pay >= 0),
  net_pay numeric(12, 2),
  hours_worked numeric(8, 2) check (hours_worked is null or hours_worked >= 0),
  regular_hours numeric(8, 2) check (regular_hours is null or regular_hours >= 0),
  overtime_hours numeric(8, 2) check (overtime_hours is null or overtime_hours >= 0),
  double_time_hours numeric(8, 2) check (double_time_hours is null or double_time_hours >= 0),
  hourly_rate numeric(10, 4) check (hourly_rate is null or hourly_rate >= 0),

  federal_tax numeric(12, 2),
  state_tax numeric(12, 2),
  social_security numeric(12, 2),
  medicare numeric(12, 2),
  other_deductions_total numeric(12, 2),

  shift_differential_amount numeric(12, 2),
  sunday_premium_amount numeric(12, 2),
  role_premium_amount numeric(12, 2),
  per_diem_amount numeric(12, 2),

  -- How the numbers got here. 'local' means the browser read the PDF's text
  -- layer and nothing left the device; 'ai' means the document was sent to the
  -- AI provider; 'manual' means typed in.
  source public.parse_source not null default 'manual',
  -- True once a human has looked at the parsed values and confirmed them.
  confirmed_by_user boolean not null default false,
  -- Set when the source document was retained at the user's request.
  document_path text,
  document_deleted_at timestamptz,

  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Net above gross is always a parsing failure, never real.
  constraint pay_stubs_net_not_above_gross
    check (gross_pay is null or net_pay is null or net_pay <= gross_pay * 1.05),
  constraint pay_stubs_date_order
    check (period_start is null or period_end is null or period_end >= period_start)
);

comment on table public.pay_stubs is
  'Figures read from a pay stub. The document itself is not stored in this table.';
comment on column public.pay_stubs.document_path is
  'Private Storage object path, only set when the user chose to retain the source document.';

create index if not exists pay_stubs_user_paydate_idx
  on public.pay_stubs (user_id, pay_date desc nulls last);
create index if not exists pay_stubs_period_idx on public.pay_stubs (pay_period_id);

drop trigger if exists pay_stubs_set_updated_at on public.pay_stubs;
create trigger pay_stubs_set_updated_at
  before update on public.pay_stubs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Line items
--
-- Three narrow tables rather than one wide one with a `kind` column, because
-- an earning has hours and a rate while a tax does not, and a nullable-heavy
-- shared table makes the line-level audit harder to read and to constrain.
-- ---------------------------------------------------------------------------

create table if not exists public.pay_stub_earnings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pay_stub_id uuid not null references public.pay_stubs (id) on delete cascade,
  label text not null,
  -- Normalised category so the audit can match "OT", "O/T", "Overtime".
  category text not null default 'other'
    check (category in ('regular', 'overtime', 'double_time', 'shift_differential',
                        'sunday_premium', 'role_premium', 'holiday', 'per_diem',
                        'bonus', 'retro', 'other')),
  hours numeric(8, 2) check (hours is null or hours >= 0),
  rate numeric(10, 4) check (rate is null or rate >= 0),
  amount numeric(12, 2) not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists pay_stub_earnings_stub_idx
  on public.pay_stub_earnings (pay_stub_id, sort_order);

create table if not exists public.pay_stub_deductions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pay_stub_id uuid not null references public.pay_stubs (id) on delete cascade,
  label text not null,
  category text not null default 'other'
    check (category in ('retirement', 'health', 'dental', 'vision', 'life',
                        'union', 'garnishment', 'loan', 'charity', 'other')),
  pre_tax boolean not null default false,
  amount numeric(12, 2) not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists pay_stub_deductions_stub_idx
  on public.pay_stub_deductions (pay_stub_id, sort_order);

create table if not exists public.pay_stub_taxes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pay_stub_id uuid not null references public.pay_stubs (id) on delete cascade,
  label text not null,
  category text not null default 'other'
    check (category in ('federal', 'state', 'local', 'social_security', 'medicare',
                        'additional_medicare', 'sdi', 'other')),
  amount numeric(12, 2) not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists pay_stub_taxes_stub_idx
  on public.pay_stub_taxes (pay_stub_id, sort_order);

-- ---------------------------------------------------------------------------
-- paycheck_audits and their discrepancies
--
-- The audit result is persisted rather than recomputed on every view, because
-- it is a comparison against a *point in time*: the rate and the rules in force
-- when the check was issued. Recomputing it after the user moves up a wage step
-- would silently change the history.
-- ---------------------------------------------------------------------------

create table if not exists public.paycheck_audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pay_stub_id uuid not null references public.pay_stubs (id) on delete cascade,
  pay_period_id uuid references public.pay_periods (id) on delete set null,

  expected_gross numeric(12, 2) not null default 0,
  actual_gross numeric(12, 2),
  gross_difference numeric(12, 2),

  expected_regular_hours numeric(8, 2) not null default 0,
  expected_overtime_hours numeric(8, 2) not null default 0,
  expected_double_time_hours numeric(8, 2) not null default 0,
  expected_effective_rate numeric(10, 4),

  -- Worst severity across all lines, so a list can be sorted without a join.
  highest_severity public.audit_severity not null default 'match',
  finding_count integer not null default 0 check (finding_count >= 0),
  incomparable_count integer not null default 0 check (incomparable_count >= 0),
  verdict text not null default '',

  -- Marked when the user has looked at it, so the dashboard can stop nagging.
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pay_stub_id)
);

comment on table public.paycheck_audits is
  'A stored expected-vs-actual comparison. Findings are phrased as things to review, never as payroll errors.';

create index if not exists paycheck_audits_user_idx
  on public.paycheck_audits (user_id, created_at desc);

drop trigger if exists paycheck_audits_set_updated_at on public.paycheck_audits;
create trigger paycheck_audits_set_updated_at
  before update on public.paycheck_audits
  for each row execute function public.set_updated_at();

create table if not exists public.paycheck_audit_discrepancies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  audit_id uuid not null references public.paycheck_audits (id) on delete cascade,
  kind text not null,
  label text not null,
  unit text not null default 'money' check (unit in ('money', 'hours', 'rate')),
  expected_value numeric(14, 4),
  actual_value numeric(14, 4),
  difference numeric(14, 4),
  difference_pct numeric(10, 4),
  severity public.audit_severity not null default 'match',
  insufficient_data boolean not null default false,
  message text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists paycheck_audit_discrepancies_audit_idx
  on public.paycheck_audit_discrepancies (audit_id, sort_order);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.pay_stubs enable row level security;
alter table public.pay_stub_earnings enable row level security;
alter table public.pay_stub_deductions enable row level security;
alter table public.pay_stub_taxes enable row level security;
alter table public.paycheck_audits enable row level security;
alter table public.paycheck_audit_discrepancies enable row level security;

drop policy if exists "pay_stubs: owner all" on public.pay_stubs;
create policy "pay_stubs: owner all"
  on public.pay_stubs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "pay_stub_earnings: owner all" on public.pay_stub_earnings;
create policy "pay_stub_earnings: owner all"
  on public.pay_stub_earnings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "pay_stub_deductions: owner all" on public.pay_stub_deductions;
create policy "pay_stub_deductions: owner all"
  on public.pay_stub_deductions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "pay_stub_taxes: owner all" on public.pay_stub_taxes;
create policy "pay_stub_taxes: owner all"
  on public.pay_stub_taxes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "paycheck_audits: owner all" on public.paycheck_audits;
create policy "paycheck_audits: owner all"
  on public.paycheck_audits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "paycheck_audit_discrepancies: owner all" on public.paycheck_audit_discrepancies;
create policy "paycheck_audit_discrepancies: owner all"
  on public.paycheck_audit_discrepancies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
