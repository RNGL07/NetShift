# NetShift

Pay, overtime, and paycheck planning built for hourly and shift workers.

NetShift is an **independent product**. It is not affiliated with, endorsed by,
or sponsored by Toyota or any other employer. Every figure it produces is an
**estimate and an educational tool** — not tax, legal, investment, payroll, or
financial advice.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Local development](#local-development)
- [Supabase setup](#supabase-setup)
- [Stripe setup (test mode)](#stripe-setup-test-mode)
- [AI setup](#ai-setup)
- [Environment variables](#environment-variables)
- [Testing and checks](#testing-and-checks)
- [Deploying to Vercel](#deploying-to-vercel)
- [Migrating from NetShift 1.x](#migrating-from-netshift-1x)
- [How the free/Pro split is enforced](#how-the-freepro-split-is-enforced)
- [Known limitations](#known-limitations)

---

## What it does

**Free**

| Feature                 | What it is                                                    |
| ----------------------- | ------------------------------------------------------------- |
| Hours → Pay             | A week or two of hours becomes an estimated paycheck          |
| Target → Hours          | Work backwards from a take-home target                        |
| Pay profile             | One profile: rate, premiums, overtime rules, pay period       |
| Wage ladder             | Where you are on your progression and what the next step pays |
| Hours logging           | Daily hours, including shifts that cross midnight             |
| Paycheck plan           | The current and next paycheck, payday to payday               |
| Paycheck audit          | Gross and hours compared against the stub                     |
| Is this shift worth it? | One extra shift, priced after tax and costs                   |
| Goals                   | One active goal                                               |
| Investments             | Manual accounts and holdings, priced with real market data    |
| Document parsing        | A configurable monthly allowance (default 5)                  |

**Pro**

Full line-by-line paycheck reconciliation, anomaly detection, unlimited
paycheck history, future paycheck plans, recurring bills, saved scenarios,
unlimited goals with hour-by-hour funding projections, variable-income buffer
and overtime-dependency analysis, debt payoff scenarios, rotation calendar
automation, the bonus planner, AI paycheck explanations, AI market reports, and
data export.

The complete matrix is on the **Plan & billing** page in the app, generated
from `src/config/plans.ts` so the page cannot drift from what the server
enforces.

---

## Architecture

```
src/
  app/            shell, routing, navigation
  components/     shared UI kit and feature gating
  config/         plans.ts — the single free/Pro source of truth
  features/       one folder per feature area
  hooks/          useCollection and friends
  lib/
    calc/         pure, tested calculation modules
    parsing/      local (in-browser) PDF pay-stub and wage-sheet parsers
    format/       display formatters
    supabase/     browser client
    api/          typed client for NetShift's own endpoints
  services/       typed data access over Supabase
  types/          database row shapes
api/
  _lib/           auth, entitlements, rate limiting, Anthropic, validation
  ai/             the four AI operations
  stripe/         checkout, portal, webhook, subscription
  account/        deletion
  prices.ts       market data (Stooq, no LLM)
supabase/
  migrations/     the schema, in order
  tests/          RLS and webhook assertions, run by scripts/db-test.sh
legacy/           the pre-2.0 prototype, kept for reference; never built
```

**Three rules the codebase is organised around.**

1. **Calculations are pure functions.** Everything in `src/lib/calc` takes data
   and returns data. No React, no network, no clock except where injected. That
   is why the overtime rules, amortisation, and safe-to-spend formula can be
   tested exhaustively, and why the Hours→Pay calculator and the paycheck audit
   cannot disagree about what an hour is worth.

2. **The browser decides what to _show_; the server decides what to _allow_.**
   `src/config/plans.ts` is imported by both. The UI uses it to render locked
   previews; `api/_lib/entitlements.ts` uses it to refuse requests. Row-level
   security is underneath both. Hiding a button is never the enforcement.

3. **Stripe webhook state is authoritative.** Nothing else writes the
   `subscriptions` table. The Checkout success redirect is treated as a hint to
   poll, never as proof of payment.

---

## Local development

Requirements: Node 20+.

```bash
npm install
cp .env.example .env.local     # then fill it in — see below
npm run dev                    # http://localhost:5173
```

`npm run dev` serves the frontend only. The `/api` functions need the Vercel
CLI:

```bash
npm i -g vercel
vercel dev                     # serves the app and the functions together
```

Without either Supabase variable set, the app renders a setup screen naming
exactly what is missing rather than failing silently.

---

## Supabase setup

### 1. Create the project

At [supabase.com](https://supabase.com), create a project and note, from
**Project Settings → API**:

- the **Project URL**
- the **anon public** key — safe for the browser
- the **service_role** key — **server-only, never prefixed `VITE_`, never
  committed.** Anyone holding it can read and write every user's data.

### 2. Apply the migrations

With the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste each file in `supabase/migrations/` into the SQL editor **in filename
order**. Every migration is written to be safely re-appliable, so a partial run
can be repeated without cleaning up first.

Then load the example wage profiles (optional):

```bash
psql "$DATABASE_URL" -f supabase/seed.sql
```

### 3. Verify it

```bash
npm run db:test
```

This spins up a throwaway PostgreSQL, applies everything twice (proving
idempotency), and runs:

- `supabase/tests/rls.sql` — two real user sessions asserting that neither can
  read or write the other's rows, that a user cannot grant themselves Pro or
  reset their own AI allowance, and that an anonymous caller sees nothing
- `supabase/tests/stripe_events.sql` — webhook duplicate suppression and
  failed-event retry
- `supabase/tests/rls_coverage.sql` — no table without RLS, no user-owned table
  reachable by `anon`

Run it against your real project with `DATABASE_URL=... npm run db:test` if you
want the same assertions there. It runs in a transaction and rolls back.

### 4. Auth settings

Under **Authentication → URL Configuration**, set the Site URL to your
deployment, and add `https://your-domain/reset-password` to the redirect
allow-list so password reset links work.

### 5. Storage

The `documents` bucket is created by migration `0008` as private, capped at
10 MB, and restricted to PDF and image types. NetShift deletes a source
document as soon as extraction succeeds unless the user opts to keep it.

---

## Stripe setup (test mode)

Everything below uses **test mode**, so no real card is charged. The
subscription price lives in Stripe and is deliberately absent from this
codebase — changing it is a dashboard action, not a deploy.

### 1. Create the product and price

1. In the Stripe dashboard, toggle **Test mode** on.
2. **Product catalogue → Add product.**
3. Name it `NetShift Pro`, choose **Recurring**, **Monthly**, and set the amount
   (the intended launch price is $15–19/month).
4. Save, then copy the **price ID** — it looks like `price_1ABC...`.
5. Set `STRIPE_PRO_PRICE_ID` to that value.

From **Developers → API keys**, copy the **Secret key** (`sk_test_...`) into
`STRIPE_SECRET_KEY`.

### 2. Configure the webhook

**Developers → Webhooks → Add endpoint.**

- URL: `https://your-domain/api/stripe/webhook`
- Events to send:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`

Copy the **signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

### 3. Forward webhooks locally

```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

`stripe listen` prints its own `whsec_...`. Use **that** one in `.env.local`
while developing — it differs from the dashboard endpoint's secret.

### 4. Enable the Customer Portal

**Settings → Billing → Customer portal**, activate it, and allow customers to
update payment methods, view invoices, and cancel. NetShift sends users
straight there; there is no retention flow in the way.

### 5. Test the full lifecycle

Stripe's test cards:

| Card                  | What happens                       |
| --------------------- | ---------------------------------- |
| `4242 4242 4242 4242` | Succeeds                           |
| `4000 0000 0000 0341` | Attaches, then fails on charge     |
| `4000 0000 0000 9995` | Declined for insufficient funds    |
| `4000 0025 0000 3155` | Requires 3-D Secure authentication |

Any future expiry, any CVC, any postcode.

**A successful purchase**

1. Sign in, go to **Plan & billing**, click **Upgrade to Pro**.
2. Pay with `4242 4242 4242 4242`.
3. You are returned to `/billing?checkout=success`. The page says
   _"Confirming your payment with Stripe"_ and polls — the redirect alone does
   not grant access.
4. Within a few seconds it reads **NetShift Pro**.
5. Check `subscriptions` in Supabase: `status = active`, `entitlement = pro`.

**A failed payment**

1. Use `4000 0000 0000 0341`.
2. Stripe creates the subscription, then the charge fails.
3. `invoice.payment_failed` arrives, the row moves to `past_due`, and
   `past_due_since` is stamped.
4. Pro stays on for the grace period (7 days, `PAST_DUE_GRACE_DAYS`) with a
   banner asking the user to update their card.

**Cancel at period end**

1. **Manage subscription → Cancel plan.**
2. `cancel_at_period_end` becomes true, status stays `active`.
3. Billing shows _"Access ends [date]"_ and Pro keeps working until then.

**Cancel immediately**

Cancel from the dashboard instead. Status becomes `canceled`;
`resolveEntitlement` keeps Pro until `current_period_end` passes, because that
period was already paid for.

**Confirm entitlements really change**

While on the free tier, calling a Pro endpoint directly must fail:

```bash
curl -X POST https://your-domain/api/ai/market-report \
  -H "Authorization: Bearer <a free user's access token>"
# {"error":{"code":"pro_required","message":"This feature is part of NetShift Pro."}}
```

That is the check that matters. The UI hiding a button proves nothing.

---

## AI setup

Create a key at [console.anthropic.com](https://console.anthropic.com) →
**Settings → API keys** and set `ANTHROPIC_API_KEY`. Usage is billed
pay-as-you-go, separately from any Claude subscription.

**Four operations**, each authenticated, entitlement-checked, and rate-limited
on the server:

| Endpoint                        | Tier | Counts against the document allowance |
| ------------------------------- | ---- | ------------------------------------- |
| `POST /api/ai/parse-paystub`    | Free | Yes                                   |
| `POST /api/ai/parse-wage-sheet` | Free | Yes                                   |
| `POST /api/ai/explain-paycheck` | Pro  | No                                    |
| `POST /api/ai/market-report`    | Pro  | No                                    |

**Parsing is local first.** A PDF exported from a payroll portal has a real
text layer, which NetShift reads **in the browser**. Nothing is uploaded and no
allowance is spent. Only photos, scans, and low-confidence local parses reach
the server. The upload screen says which path a file will take before the
picker opens.

**Allowances are configurable** through `NETSHIFT_FREE_MONTHLY_DOCUMENT_PARSES`
and the related variables (see `.env.example`); `-1` means unlimited. They are
claimed atomically in the database before the provider is called and released
if it fails, so a provider outage never costs a user a parse.

**Model names are configurable** via `ANTHROPIC_EXTRACTION_MODEL`,
`ANTHROPIC_EXPLANATION_MODEL`, and `ANTHROPIC_REPORT_MODEL`.

**What is not logged:** document bytes, extracted financial values, and
provider error text. `ai_usage_events` records the operation, model, token
counts, and outcome — nothing else.

---

## Environment variables

See `.env.example` for the annotated list. In short:

| Variable                      | Where            | Purpose                               |
| ----------------------------- | ---------------- | ------------------------------------- |
| `VITE_SUPABASE_URL`           | Browser + server | Supabase project URL                  |
| `VITE_SUPABASE_ANON_KEY`      | Browser          | Anon key — public by design           |
| `SUPABASE_URL`                | Server           | Same URL, for the functions           |
| `SUPABASE_ANON_KEY`           | Server           | Same anon key, for acting as a caller |
| `SUPABASE_SERVICE_ROLE_KEY`   | Server only      | **Bypasses RLS.** Never `VITE_`       |
| `ANTHROPIC_API_KEY`           | Server only      | AI operations                         |
| `STRIPE_SECRET_KEY`           | Server only      | Stripe API                            |
| `STRIPE_WEBHOOK_SECRET`       | Server only      | Webhook signature verification        |
| `STRIPE_PRO_PRICE_ID`         | Server           | The recurring price to sell           |
| `STRIPE_TRIAL_DAYS`           | Server           | Optional trial length                 |
| `APP_URL`                     | Server           | Public origin for Stripe return URLs  |
| `NETSHIFT_*_MONTHLY_*`        | Server           | Configurable AI allowances            |
| `NETSHIFT_MAX_DOCUMENT_BYTES` | Server           | Upload cap, default 8 MB              |

`VITE_STRIPE_PUBLISHABLE_KEY` is **not** required — the integration redirects
to Stripe Checkout rather than mounting Stripe.js.

---

## Testing and checks

```bash
npm run verify     # lint + typecheck + tests + production build
npm test           # 433 tests
npm run typecheck
npm run lint
npm run build
npm run db:test    # migrations, RLS isolation, webhook idempotency
bash scripts/check-bundle-secrets.sh    # after a build
```

**What is covered.** Daily and weekly overtime including the case where an hour
must not be counted as both; Sunday treatment and its interaction with the
weekly threshold; double time; shift differentials; per diem added after
withholding rather than before; cross-midnight shifts; safe-to-spend and the
bill-window rules that prevent double-counting; goal hour conversions; debt
amortisation including a payment that does not cover interest; snowball and
avalanche ordering; variable-income statistics; bonus allocation caps; rotation
generation and exceptions; the pay-stub and wage-sheet parsers; and the audit's
tone rules.

On the server: 401 for every protected endpoint unauthenticated _and_ with a
forged token; 402 for a free user on a Pro endpoint with the AI provider never
contacted; 429 on allowance exhaustion; document validation by magic bytes and
decoded size; and twelve webhook tests that compute real Stripe signatures and
assert rejection of a wrong secret, a tampered body, and a replayed timestamp.

`scripts/check-bundle-secrets.sh` greps the built bundle for server-only names
and credential shapes, and checks that no client module imports from `api/`. It
has been verified against a build with real-shaped canary credentials present
in the environment.

---

## Deploying to Vercel

1. Push the repository to GitHub.
2. **Add New → Project** at vercel.com and import it.
3. Vercel detects Vite from `vercel.json`. Leave the build settings alone.
4. Add every variable from the table above under **Settings → Environment
   Variables**. Set the `VITE_`-prefixed ones for all environments; keep the
   secrets to Production and Preview.
5. Deploy.
6. Point your Stripe webhook at `https://your-domain/api/stripe/webhook` and
   put its signing secret in `STRIPE_WEBHOOK_SECRET`.
7. Add `https://your-domain/reset-password` to Supabase's redirect allow-list.

`vercel.json` also sets the SPA rewrite (so a deep link like `/billing`
resolves) and security headers, and gives the functions a 60-second budget for
document parsing.

---

## Migrating from NetShift 1.x

NetShift 1.x stored everything as JSON strings in a `netshift_data` key/value
table. Migration `0009` keeps that table, revokes write access to it, and adds
a summary view.

On first sign-in a user with legacy rows is offered an import. It runs
**client-side, on their own data, and only on confirmation**, because the
alternative — a silent server-side bulk transform of unvalidated prototype JSON
into financial records — would write figures the user never sees and cannot
check.

Every value is validated on the way in. A stub whose net exceeds its gross, a
wage step outside a plausible hourly range, a premium that is obviously a
weekly figure: all skipped and reported, never coerced. **The legacy rows are
not deleted by the import** — the user removes them from Settings once they have
confirmed the figures came across.

`netshift_data` can be dropped once no profile has
`legacy_import_status = 'pending'`.

---

## How the free/Pro split is enforced

Three independent layers, in order of authority:

1. **Row-level security.** Every user-owned table is owner-only, with a
   `with check` on writes so a user cannot create a row attributed to someone
   else. `subscriptions`, `ai_usage_counters`, and `ai_usage_events` are
   read-only to their owner — entitlement and allowance cannot be self-granted.
   `stripe_events` and `rate_limit_buckets` have no policy at all and are
   service-role only.

2. **Server-side checks.** Every Pro endpoint calls `requireFeature` or
   `requirePro`. Every AI endpoint claims allowance atomically _before_
   contacting the provider.

3. **The UI.** Locked features show an informative preview rather than
   disappearing, because a user who cannot see a feature exists cannot decide
   whether it is worth paying for.

Only the first two are security. The third is presentation, and the code says
so where it matters.

**Which subscription states grant Pro**

| Status                                                       | Pro?                       | Why                                                                                                                         |
| ------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `active`                                                     | Yes                        | Paid                                                                                                                        |
| `trialing`                                                   | Yes                        | Valid trial                                                                                                                 |
| `past_due`                                                   | Yes, for 7 days            | Stripe is still retrying; a declined card should not lock someone out mid-paycheck. The clock runs from the _first_ failure |
| `canceled`                                                   | Until `current_period_end` | That period was already paid for                                                                                            |
| `unpaid`, `incomplete`, `incomplete_expired`, `paused`, none | No                         |                                                                                                                             |

---

## Known limitations

- **NetShift never has authoritative payroll data.** The audit compares its own
  estimate against what a stub says. It reports differences worth checking and
  never claims payroll made an error, because it cannot know that.
- **Withholding is estimated, not calculated.** NetShift learns an average
  deduction rate from saved stubs. It does not model tax brackets, allowances,
  or year-to-date effects, and overtime is often withheld at a higher rate than
  the average suggests.
- **Example wage profiles are unofficial.** They are community-reported or from
  public sources, carry a `source_status`, and should be checked against your
  own paperwork.
- **Market prices come from a free public source** (Stooq) and may be delayed.
  Workplace retirement funds usually have no public ticker and need a manual
  price. Prices are never obtained from a language model.
- **Cross-midnight shifts are attributed to the day they start.** That is the
  common manufacturing convention; employers that split at midnight will differ.
- **Semi-monthly and monthly pay periods are approximated** as a fixed number of
  weeks for hour-based estimates. Overtime is still evaluated per week.
- **Rotation shifts are generated, not stored.** Changing a pattern changes
  every future day at once, which is the point — but it also means there is no
  historical record of what a rotation _used to_ say.
