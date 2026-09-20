-- ---------------------------------------------------------------------------
-- 0010 — Explicit table privileges.
--
-- Supabase's default privileges normally grant new public tables to `anon`,
-- `authenticated`, and `service_role` automatically. Relying on that is fragile:
-- if a project's default privileges have ever been altered, tables created by
-- these migrations come out unreachable, and the failure appears as a confusing
-- "permission denied" long after deploy.
--
-- So the grants are stated here, deliberately:
--   - `authenticated` gets CRUD on user-owned tables. RLS, not the grant, is
--     what confines a user to their own rows.
--   - `authenticated` gets SELECT only on shared reference data.
--   - `anon` gets nothing. Every feature requires a signed-in user, so an
--     unauthenticated role has no reason to hold a grant on any table.
--   - `service_role` bypasses RLS and gets everything; it is only ever used
--     from the serverless functions, never from the browser.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

-- --- User-owned tables: full CRUD for the owner, confined by RLS -----------

grant select, insert, update, delete on
  public.profiles,
  public.user_pay_profiles,
  public.user_wage_ladder_steps,
  public.pay_periods,
  public.logged_shifts,
  public.pay_stubs,
  public.pay_stub_earnings,
  public.pay_stub_deductions,
  public.pay_stub_taxes,
  public.paycheck_audits,
  public.paycheck_audit_discrepancies,
  public.bills,
  public.paycheck_plans,
  public.paycheck_plan_allocations,
  public.goals,
  public.goal_contributions,
  public.debts,
  public.debt_payments,
  public.debt_payoff_scenarios,
  public.buffer_settings,
  public.buffer_snapshots,
  public.shift_scenarios,
  public.rotation_patterns,
  public.rotation_exceptions,
  public.bonuses,
  public.bonus_allocations,
  public.investment_accounts,
  public.holdings,
  public.market_reports,
  public.notification_preferences
to authenticated;

-- --- Read-only for the owner; writes are service-role only ----------------
--
-- These carry state a user must not be able to set for themselves: their own
-- entitlement, their own AI allowance, and the audit trail of AI calls.

grant select on
  public.subscriptions,
  public.ai_usage_events,
  public.ai_usage_counters
to authenticated;

-- Legacy data is readable and deletable but never writable in 2.x.
grant select, delete on public.netshift_data to authenticated;
grant select on public.legacy_data_summary to authenticated;

-- Explanations are inserted by the AI endpoints only, so that one cannot exist
-- without a corresponding entitlement-checked call.
grant select, delete on public.ai_explanations to authenticated;

-- --- Shared reference data: read-only -------------------------------------

grant select on
  public.employers,
  public.employer_locations,
  public.wage_profile_versions,
  public.wage_ladder_steps,
  public.market_prices
to authenticated;

-- --- Service role ---------------------------------------------------------

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- `stripe_events` is deliberately absent from every `authenticated` grant
-- above: it is service-role only.

-- --- Future tables --------------------------------------------------------
--
-- Keeps a later migration from silently creating an unreachable table.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
