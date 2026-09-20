# NetShift production deployment checklist

Current `main`: `558df67`. The code fixes are merged and deployed to Vercel.
Everything below is configuration that has to be done by hand, in order.

---

## 0. Apply the database migrations (do this first)

The code is deployed; the schema is not. Migrations are **not** applied by the
Vercel build — they are a separate, manual step against the production
Supabase project.

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Then confirm all fourteen migrations are recorded:

```sql
select version from supabase_migrations.schema_migrations order by version;
-- the last one must be 20260101001300 (backfill_existing_users)
```

**Why `0013` is not optional:** it backfills `profiles` and `subscriptions`
rows for users who existed before the schema change. `handle_new_user()` fires
`after insert on auth.users`, so it never ran for them. Without the backfill,
the legacy-import flow cannot record that it ran — the completion write is an
`update public.profiles ... where id = <user id>`, which matches zero rows, and
the prompt's own `maybeSingle()` read returns null and defaults back to
`pending` —
so the import prompt returns on every load and pay stubs can be imported
repeatedly, duplicating financial records that then corrupt the audit, the
buffer recommendation, and the learned deduction rate.

Until this is applied, **do not sign in with an account that existed before
the restructure.**

---

## 1. Vercel environment variables

Report only present/missing — never paste values.

### Required (the app fails without these)

| Variable                    | Scope  | Notes                              |
| --------------------------- | ------ | ---------------------------------- |
| `VITE_SUPABASE_URL`         | All    | Public by design                   |
| `VITE_SUPABASE_ANON_KEY`    | All    | Public by design                   |
| `SUPABASE_URL`              | Server | Same URL as above                  |
| `SUPABASE_ANON_KEY`         | Server | Same anon key as above             |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | **Bypasses RLS.** Never `VITE_`    |
| `ANTHROPIC_API_KEY`         | Server | Document parsing, reports          |
| `STRIPE_SECRET_KEY`         | Server | Use `sk_test_…` for now            |
| `STRIPE_PRO_PRICE_ID`       | Server | `price_…` from the recurring price |
| `STRIPE_WEBHOOK_SECRET`     | Server | `whsec_…` from the endpoint        |

### Optional (sensible defaults if absent)

`APP_URL` (set it if you use a custom domain — otherwise Vercel's own URL is
used for Stripe return links), `STRIPE_TRIAL_DAYS`, `ANTHROPIC_*_MODEL`,
`NETSHIFT_*_MONTHLY_*` allowances, `NETSHIFT_MAX_DOCUMENT_BYTES`.

`VITE_STRIPE_PUBLISHABLE_KEY` is **not needed** — checkout is a redirect.

**No market-data variable exists.** `/api/prices` uses Stooq, which needs no key.

---

## 2. Supabase configuration

- [ ] All migrations applied, **including `0013`**
- [ ] `supabase/seed.sql` applied (optional — example wage profiles)
- [ ] **Authentication → URL Configuration → Site URL** = production URL
- [ ] **Redirect allow-list** includes `https://<your-domain>/reset-password`
- [ ] **Storage** — the `documents` bucket exists, is **private**, 10 MB cap,
      MIME-restricted (created by migration `0008`)
- [ ] Verify RLS against the real database:
      `DATABASE_URL="postgresql://…" npm run db:test`
      (runs in a transaction and rolls back)

---

## 3. Stripe (test mode)

- [ ] Test mode **on**
- [ ] Recurring monthly product + price created; ID in `STRIPE_PRO_PRICE_ID`
- [ ] Webhook endpoint → `https://<your-domain>/api/stripe/webhook`
- [ ] Events enabled — **all six are required**:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`
- [ ] Signing secret → `STRIPE_WEBHOOK_SECRET`
- [ ] Customer Portal **activated**, with cancel + payment-method update allowed

Checkout success/cancel and portal return URLs are **built by the code** from
`APP_URL`, so there is nothing to configure in Stripe for those:

- success → `/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`
- cancel → `/billing?checkout=cancelled`
- portal return → `/billing`

Set `APP_URL` if you use a custom domain, or these point at the Vercel URL.

---

## 4. Production smoke tests

Use a **dedicated test account**. Do not use real payroll data.

### Auth

1. [ ] Create account; confirm the email
2. [ ] Sign in, then sign out
3. [ ] Request a password reset; follow the link; set a new password
       _(verifies the `/reset-password` allow-list entry)_

### Core (free tier)

4. [ ] Create a Pay Profile — rate, premiums, overtime rules, a recent payday
5. [ ] Hours → Pay, and Target → Hours
6. [ ] Log shifts for a week; check the paycheck forecast
7. [ ] Create one goal
8. [ ] Create a bill; open the Paycheck Plan; check safe-to-spend
9. [ ] "Is this shift worth it?" — confirm it prices against hours already logged

### Authorization (the important one)

10. [ ] As a **free** user, call a Pro endpoint directly:

```bash
curl -i -X POST https://<domain>/api/ai/market-report \
  -H "Authorization: Bearer <free user's access token>"
# expect 402 {"error":{"code":"pro_required", ...}}
```

Repeat unauthenticated — expect **401**.

### Billing

11. [ ] Upgrade → Checkout with `4242 4242 4242 4242`
12. [ ] Return to `/billing`; confirm it polls, then shows Pro.
        Check `subscriptions` in Supabase: `status=active`, `entitlement=pro`
13. [ ] Open Customer Portal
14. [ ] Cancel at period end → status stays `active`,
        `cancel_at_period_end=true`, Pro still works, "Access ends" shown
15. [ ] Failed payment with `4000 0000 0000 0341` → `past_due`,
        Pro continues through the 7-day grace, banner appears

### Documents

16. [ ] Upload a **text-layer PDF** → parses locally, allowance **unchanged**
        Upload a **photo/image** → parses server-side, allowance **decrements by 1**
17. [ ] Confirm the counter on `/billing` matches
18. [ ] Delete the sample records; confirm they are gone

### Isolation

19. [ ] Create a second test account; confirm it sees none of the first's data

### Mobile

20. [ ] 375 px, 390 px, 414 px — no horizontal scroll; tables render as cards

---

## 5. Known gaps to watch for (not yet verified in production)

The NodeNext typecheck now runs as part of the Vercel build and passed on
both the preview and the production deployment of `558df67`, so the ESM
extension class of error is ruled out at build time. The following are still
unverified, because nothing has issued a real request against the deployed
runtime:

- The `/api/*` functions have only been exercised by unit tests. Build success
  proves they compile, not that they respond.
- `pdfjs-dist` worker loading in production (local PDF parsing) is untested
  against Vercel's static asset serving.
- Stripe webhook signature verification depends on `bodyParser: false` being
  honoured by the deployed runtime.

Test 16 and test 11 cover the last two; test 10 covers the first.

---

## 6. Defect log

Record anything found during the section 4 smoke tests here, one row per
defect, so triage does not depend on memory.

| #   | Severity | Area | Repro | Expected | Actual | Blocking? |
| --- | -------- | ---- | ----- | -------- | ------ | --------- |

Severity: **S1** data loss, cross-user access, broken auth, broken billing, or
a core workflow that cannot be completed. **S2** a feature is wrong but usable.
**S3** usability or cosmetic. Only S1 blocks use of the app.

### Open items carried in from development

These are known and deliberately not fixed; they are not blockers.

- **S3 — wage-sheet parsing is heuristic.** The local parser handles row-wise
  layouts and the column-header/rate-row tabular layout. An unusual layout
  falls through to the AI path, which costs one parse from the monthly
  allowance. Working as designed, but worth logging which real documents take
  which path.
- **S3 — pay-stub rate/hours disagreement.** When rate and hours are each
  individually plausible but their product does not match gross, and gross
  cannot arbitrate, `applySanityChecks` surfaces the disagreement rather than
  guessing. The user has to resolve it by hand. Needs real-document testing to
  learn how often this fires.
- **S2 — no production runtime exercise of `/api/*`.** See section 5. The
  first real request is smoke test 10.
