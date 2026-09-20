-- ---------------------------------------------------------------------------
-- Seed data — shared example wage profiles.
--
-- These are unofficial, community-reported starting points. NetShift is an
-- independent product with no affiliation to, or endorsement from, any
-- employer named here, and every row is marked `community_submitted` so the
-- UI cannot present it as verified payroll data.
--
-- Safe to re-run: every insert is keyed on a natural unique constraint.
-- ---------------------------------------------------------------------------

insert into public.employers (name, slug, industry, is_example)
values ('Toyota (TMMTX)', 'toyota-tmmtx', 'Automotive manufacturing', true)
on conflict (slug) do nothing;

insert into public.employer_locations (employer_id, name, city, state_code)
select e.id, 'San Antonio, TX', 'San Antonio', 'TX'
from public.employers e
where e.slug = 'toyota-tmmtx'
on conflict (employer_id, name) do nothing;

-- --- Skilled Team Member ---------------------------------------------------

insert into public.wage_profile_versions (
  employer_id, location_id, job_classification, source_status, source_note,
  effective_from, shift_premium, role_premium, role_premium_label,
  daily_overtime_threshold, weekly_overtime_threshold,
  overtime_multiplier, double_time_multiplier, sunday_treatment
)
select
  e.id, l.id, 'Skilled Team Member', 'community_submitted',
  'Community-reported progression. Unofficial — confirm against your own paperwork.',
  date '2026-03-23', 0.80, 2.25, 'Team leader premium',
  8, 40, 1.5, 2, 'regular'
from public.employers e
join public.employer_locations l
  on l.employer_id = e.id and l.name = 'San Antonio, TX'
where e.slug = 'toyota-tmmtx'
on conflict (employer_id, location_id, job_classification, effective_from) do nothing;

insert into public.wage_ladder_steps (wage_profile_version_id, label, tenure_months, hourly_rate, is_top_rate, sort_order)
select v.id, s.label, s.tenure_months, s.rate, s.is_top, s.sort_order
from public.wage_profile_versions v
join public.employers e on e.id = v.employer_id
cross join (values
  ('Start',              0,  35.90, false, 0),
  ('6 Months',           6,  39.15, false, 1),
  ('1 Year',            12,  40.61, false, 2),
  ('1.5 Years',         18,  42.18, false, 3),
  ('2 Years',           24,  43.55, false, 4),
  ('2.5 Years',         30,  45.75, false, 5),
  ('3 Years (Top Rate)',36,  47.95, true,  6)
) as s(label, tenure_months, rate, is_top, sort_order)
where e.slug = 'toyota-tmmtx'
  and v.job_classification = 'Skilled Team Member'
  and v.effective_from = date '2026-03-23'
on conflict (wage_profile_version_id, tenure_months) do nothing;

-- --- Production Team Member ------------------------------------------------

insert into public.wage_profile_versions (
  employer_id, location_id, job_classification, source_status, source_note,
  effective_from, shift_premium, role_premium, role_premium_label,
  daily_overtime_threshold, weekly_overtime_threshold,
  overtime_multiplier, double_time_multiplier, sunday_treatment
)
select
  e.id, l.id, 'Production Team Member', 'community_submitted',
  'Community-reported progression. Unofficial — confirm against your own paperwork.',
  date '2026-03-23', 0.80, 1.75, 'Team leader premium',
  8, 40, 1.5, 2, 'regular'
from public.employers e
join public.employer_locations l
  on l.employer_id = e.id and l.name = 'San Antonio, TX'
where e.slug = 'toyota-tmmtx'
on conflict (employer_id, location_id, job_classification, effective_from) do nothing;

insert into public.wage_ladder_steps (wage_profile_version_id, label, tenure_months, hourly_rate, is_top_rate, sort_order)
select v.id, s.label, s.tenure_months, s.rate, s.is_top, s.sort_order
from public.wage_profile_versions v
join public.employers e on e.id = v.employer_id
cross join (values
  ('Start',              0,  23.00, false, 0),
  ('6 Months',           6,  25.97, false, 1),
  ('1 Year',            12,  26.91, false, 2),
  ('1.5 Years',         18,  27.84, false, 3),
  ('2 Years',           24,  28.76, false, 4),
  ('2.5 Years',         30,  31.55, false, 5),
  ('3 Years',           36,  32.47, false, 6),
  ('3.5 Years',         42,  34.77, false, 7),
  ('4 Years (Top Rate)',48,  37.11, true,  8)
) as s(label, tenure_months, rate, is_top, sort_order)
where e.slug = 'toyota-tmmtx'
  and v.job_classification = 'Production Team Member'
  and v.effective_from = date '2026-03-23'
on conflict (wage_profile_version_id, tenure_months) do nothing;
