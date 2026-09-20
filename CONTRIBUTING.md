# Working on NetShift

A short guide to the conventions that are load-bearing rather than cosmetic.

## Before you push

```bash
npm run verify     # lint, typecheck, tests, production build
npm run db:test    # migrations, RLS isolation, webhook idempotency
npm run build && bash scripts/check-bundle-secrets.sh
```

## Where code goes

**Calculations belong in `src/lib/calc`, as pure functions.** No React, no
network, no `new Date()` that a test cannot inject. If a number appears on
screen, the function that produced it should be callable from a test with
plain inputs. This is what lets the Hours→Pay calculator, the paycheck audit,
and the shift evaluator agree about what an hour is worth — they all call the
same `bucketWeek`.

**Data access belongs in `src/services`.** That is where snake_case rows become
camelCase domain objects. Components should not know column names.

**Anything a user is allowed or forbidden to do belongs on the server.** A
check in a component is a presentation decision. `api/_lib/entitlements.ts` and
row-level security are the enforcement.

## Adding a feature to a plan

Add it to `FEATURES` in `src/config/plans.ts` with a tier. That one entry
drives the navigation badge, the locked preview, the comparison table on the
billing page, and `requireFeature` on the server — so they cannot disagree.

If the feature has a _quantity_ limit rather than an on/off one, add it to
`PlanLimits` and check it with `withinLimit`.

## Adding a table

1. Write a new migration in `supabase/migrations/` with the next timestamp.
2. Enable RLS and add an owner-only policy. `npm run db:test` fails the build
   if you forget: `rls_coverage.sql` asserts that no table in `public` is
   without RLS and no user-owned table is reachable by `anon`.
3. Grant `authenticated` only what it needs, in `20260101001000_grants.sql` or
   a later migration. State-carrying tables a user must not write — anything
   that decides entitlement, allowance, or rate limits — get `select` only.
4. Make the migration re-appliable: `drop policy if exists` before
   `create policy`, `drop trigger if exists` before `create trigger`. People
   paste these into the SQL editor and re-run them.

## Tone

NetShift talks to people about money that is already tight. Three rules:

- **The audit never accuses.** NetShift has no authoritative payroll data, so
  a difference is "worth reviewing", never an error. `src/lib/calc/audit.ts`
  has a test asserting the output contains no accusatory language.
- **An estimate is labelled an estimate.** The `estimated` prop on `Stat`
  exists for this. Withholding, forecasts, and projections are all estimates.
- **No dark patterns in billing.** Cancellation goes straight to Stripe's
  portal. There is no retention flow, and there never should be.

## Errors

Server errors carry a stable `code` and a sentence a user can act on — never a
stack trace, a provider message, a SQL error, or an environment variable name.
`fail()` in `api/_lib/http.ts` is the only way an endpoint reports a problem,
so the rule is hard to forget.

Never log document contents or extracted financial values.

## Tests worth writing

Anything where being subtly wrong would be invisible: overtime boundaries, date
arithmetic across DST and month ends, amortisation edge cases, allocation caps,
and every authorization check. The bar is "would a plausible mistake here reach
production unnoticed?"
