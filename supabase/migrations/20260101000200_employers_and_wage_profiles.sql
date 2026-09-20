-- ---------------------------------------------------------------------------
-- 0002 — Employers, facilities, wage-profile versions, and wage steps.
--
-- These are the only *shared* tables in the schema: a wage profile for a given
-- employer and classification is useful to every user who works there. They are
-- therefore world-readable to signed-in users and writable only by the service
-- role, with a `source_status` on every version so the UI can never present a
-- community-reported figure as if it were verified payroll data.
--
-- A user's own overrides live in `user_pay_profiles` (migration 0003) and are
-- private to them.
-- ---------------------------------------------------------------------------

create table if not exists public.employers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Lower-cased, punctuation-stripped name used for the uniqueness constraint,
  -- so "Toyota" and "toyota," do not become two employers.
  slug text not null unique,
  industry text,
  -- NetShift is independent; this flag is never used to imply endorsement.
  is_example boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.employers is
  'Shared employer directory. NetShift is not affiliated with or endorsed by any employer listed.';

drop trigger if exists employers_set_updated_at on public.employers;
create trigger employers_set_updated_at
  before update on public.employers
  for each row execute function public.set_updated_at();

create table if not exists public.employer_locations (
  id uuid primary key default gen_random_uuid(),
  employer_id uuid not null references public.employers (id) on delete cascade,
  name text not null,
  city text,
  state_code text check (state_code is null or char_length(state_code) = 2),
  country_code text not null default 'US' check (char_length(country_code) = 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employer_id, name)
);

comment on table public.employer_locations is 'Facilities or sites belonging to an employer.';

create index if not exists employer_locations_employer_idx
  on public.employer_locations (employer_id);

drop trigger if exists employer_locations_set_updated_at on public.employer_locations;
create trigger employer_locations_set_updated_at
  before update on public.employer_locations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- wage_profile_versions
--
-- Versioned rather than mutable: a wage sheet is only true between two dates,
-- and an audit of a 2025 paycheck must price it at the 2025 rates. Superseding
-- a version sets `effective_to` rather than editing the old rows.
-- ---------------------------------------------------------------------------

create table if not exists public.wage_profile_versions (
  id uuid primary key default gen_random_uuid(),
  employer_id uuid not null references public.employers (id) on delete cascade,
  location_id uuid references public.employer_locations (id) on delete set null,
  job_classification text not null,
  source_status public.wage_source_status not null default 'community_submitted',
  -- Free-text provenance, e.g. "uploaded wage sheet, March 2026".
  source_note text,
  -- The user who submitted it, kept for moderation. Null for seeded profiles.
  submitted_by uuid references auth.users (id) on delete set null,
  effective_from date not null,
  effective_to date,
  shift_premium numeric(10, 4) not null default 0 check (shift_premium >= 0),
  evening_premium numeric(10, 4) check (evening_premium is null or evening_premium >= 0),
  night_premium numeric(10, 4) check (night_premium is null or night_premium >= 0),
  role_premium numeric(10, 4) not null default 0 check (role_premium >= 0),
  role_premium_label text not null default 'Team leader premium',
  daily_overtime_threshold numeric(6, 2)
    check (daily_overtime_threshold is null or daily_overtime_threshold > 0),
  weekly_overtime_threshold numeric(6, 2)
    check (weekly_overtime_threshold is null or weekly_overtime_threshold > 0),
  overtime_multiplier numeric(5, 3) not null default 1.5 check (overtime_multiplier >= 1),
  double_time_multiplier numeric(5, 3) not null default 2 check (double_time_multiplier >= 1),
  sunday_treatment public.sunday_treatment not null default 'regular',
  -- Multiplier applied to a recognised holiday, when the employer has one.
  holiday_multiplier numeric(5, 3) check (holiday_multiplier is null or holiday_multiplier >= 1),
  per_diem_rate numeric(10, 2) check (per_diem_rate is null or per_diem_rate >= 0),
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A version cannot end before it begins.
  constraint wage_profile_versions_date_order
    check (effective_to is null or effective_to >= effective_from),
  -- One published version per classification per start date.
  unique (employer_id, location_id, job_classification, effective_from)
);

comment on table public.wage_profile_versions is
  'A versioned wage profile for one employer classification. Unofficial unless source_status says otherwise.';
comment on column public.wage_profile_versions.source_status is
  'Provenance. Never upgraded automatically — community_submitted stays community_submitted.';

create index if not exists wage_profile_versions_lookup_idx
  on public.wage_profile_versions (employer_id, job_classification, effective_from desc)
  where is_published;

create index if not exists wage_profile_versions_location_idx
  on public.wage_profile_versions (location_id);

drop trigger if exists wage_profile_versions_set_updated_at on public.wage_profile_versions;
create trigger wage_profile_versions_set_updated_at
  before update on public.wage_profile_versions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- wage_ladder_steps
-- ---------------------------------------------------------------------------

create table if not exists public.wage_ladder_steps (
  id uuid primary key default gen_random_uuid(),
  wage_profile_version_id uuid not null
    references public.wage_profile_versions (id) on delete cascade,
  label text not null,
  -- Months of tenure at which the step takes effect. The ordering key.
  tenure_months integer not null check (tenure_months >= 0),
  hourly_rate numeric(10, 4) not null check (hourly_rate > 0),
  is_top_rate boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (wage_profile_version_id, tenure_months)
);

comment on table public.wage_ladder_steps is 'Tenure-based wage steps within one wage profile version.';

create index if not exists wage_ladder_steps_version_idx
  on public.wage_ladder_steps (wage_profile_version_id, sort_order);

-- ---------------------------------------------------------------------------
-- RLS
--
-- Shared reference data: any signed-in user may read published rows. Writes
-- go through the service role, so a user cannot silently alter a wage profile
-- that other users rely on.
-- ---------------------------------------------------------------------------

alter table public.employers enable row level security;
alter table public.employer_locations enable row level security;
alter table public.wage_profile_versions enable row level security;
alter table public.wage_ladder_steps enable row level security;

drop policy if exists "employers: signed-in users can read" on public.employers;
create policy "employers: signed-in users can read"
  on public.employers for select
  to authenticated
  using (true);

drop policy if exists "employer_locations: signed-in users can read" on public.employer_locations;
create policy "employer_locations: signed-in users can read"
  on public.employer_locations for select
  to authenticated
  using (true);

drop policy if exists "wage_profile_versions: signed-in users can read published" on public.wage_profile_versions;
create policy "wage_profile_versions: signed-in users can read published"
  on public.wage_profile_versions for select
  to authenticated
  using (is_published);

drop policy if exists "wage_ladder_steps: signed-in users can read published" on public.wage_ladder_steps;
create policy "wage_ladder_steps: signed-in users can read published"
  on public.wage_ladder_steps for select
  to authenticated
  using (
    exists (
      select 1
      from public.wage_profile_versions v
      where v.id = wage_ladder_steps.wage_profile_version_id
        and v.is_published
    )
  );
