/**
 * Plan and billing.
 *
 * Deliberate choices here, all of them anti-dark-pattern:
 *  - Cancelling goes straight to Stripe's portal. There is no retention flow,
 *    no "are you sure", no offer in the way.
 *  - The full free/Pro comparison is always shown, including to Pro users, so
 *    what is being paid for stays visible.
 *  - Returning from Checkout *polls for the webhook* rather than assuming
 *    success, because the redirect is not proof of payment.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import {
  Badge,
  Button,
  Callout,
  DefinitionRow,
  ErrorMessage,
  Grid,
  LoadingState,
  Panel,
  Stat,
} from '@/components/ui';
import { useEntitlement } from './EntitlementContext';
import { apiRequest, ApiClientError } from '@/lib/api/client';
import { FEATURES, PLAN_LIMITS, type FeatureDefinition } from '@/config/plans';
import { formatIsoDate } from '@/lib/calc/dates';
import './billing.css';

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return formatIsoDate(
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
  );
}

export function BillingPage() {
  const { subscription, loading, isPro, refresh, waitForUpgrade } = useEntitlement();
  const [searchParams, setSearchParams] = useSearchParams();
  const [busy, setBusy] = useState<'checkout' | 'portal' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutState, setCheckoutState] = useState<
    'idle' | 'confirming' | 'confirmed' | 'pending'
  >('idle');

  const checkoutParam = searchParams.get('checkout');

  useEffect(() => {
    if (checkoutParam !== 'success') return;

    // The success redirect proves only that the browser came back from Stripe.
    // Entitlement is written by the webhook, so poll for it rather than
    // assuming — and say so plainly if it has not landed yet.
    setCheckoutState('confirming');
    void waitForUpgrade().then((upgraded) => {
      setCheckoutState(upgraded ? 'confirmed' : 'pending');
      const next = new URLSearchParams(searchParams);
      next.delete('checkout');
      next.delete('session_id');
      setSearchParams(next, { replace: true });
    });
  }, [checkoutParam, waitForUpgrade, searchParams, setSearchParams]);

  async function startCheckout() {
    setBusy('checkout');
    setError(null);
    try {
      const { url } = await apiRequest<{ url: string }>('/api/stripe/checkout');
      window.location.assign(url);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not start checkout. Please try again.',
      );
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy('portal');
    setError(null);
    try {
      const { url } = await apiRequest<{ url: string }>('/api/stripe/portal');
      window.location.assign(url);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not open the billing portal. Please try again.',
      );
      setBusy(null);
    }
  }

  if (loading && checkoutState === 'idle') {
    return <LoadingState label="Loading your plan…" />;
  }

  const parses = subscription.documentParses;

  return (
    <>
      <PageHeader
        title="Plan & billing"
        description="What your plan includes, and how to change it."
      />

      {checkoutParam === 'cancelled' && (
        <Callout tone="neutral">
          Checkout was cancelled. Nothing was charged, and you are still on the free plan.
        </Callout>
      )}

      {checkoutState === 'confirming' && (
        <Callout tone="info" icon="…">
          Confirming your payment with Stripe. This usually takes a few seconds.
        </Callout>
      )}

      {checkoutState === 'confirmed' && (
        <Callout tone="success" icon="✓">
          <strong>You are on NetShift Pro.</strong> Everything below is unlocked.
        </Callout>
      )}

      {checkoutState === 'pending' && (
        <Callout tone="warning" icon="!">
          <strong>
            Your payment went through, but we have not had confirmation from Stripe yet.
          </strong>{' '}
          This is usually a short delay. Use <em>Refresh</em> below in a minute — nothing is lost,
          and you have not been charged twice.
        </Callout>
      )}

      <ErrorMessage>{error}</ErrorMessage>

      <Panel
        title="Your plan"
        actions={
          <Button variant="ghost" onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      >
        <Grid min={200}>
          <Stat
            label="Current plan"
            value={isPro ? 'NetShift Pro' : 'Free'}
            tone={isPro ? 'positive' : 'default'}
            size="large"
          />
          <Stat
            label="Document parses this month"
            value={
              parses.limit === null
                ? `${parses.used} · unlimited`
                : `${parses.used} / ${parses.limit}`
            }
            sub={
              parses.limit === null
                ? 'No monthly cap on your plan.'
                : `${parses.remaining ?? 0} left. Resets at the start of next month.`
            }
            tone={parses.remaining !== null && parses.remaining <= 1 ? 'warning' : 'default'}
          />
        </Grid>

        <Callout tone={subscription.inGracePeriod ? 'warning' : 'neutral'}>
          {subscription.reason}
        </Callout>

        {subscription.hasBillingAccount && (
          <div className="ns-billing__details">
            <DefinitionRow
              term="Status"
              value={<Badge tone={isPro ? 'green' : 'neutral'}>{subscription.status}</Badge>}
            />
            {subscription.currentPeriodEnd && (
              <DefinitionRow
                term={subscription.cancelAtPeriodEnd ? 'Access ends' : 'Renews on'}
                value={formatTimestamp(subscription.currentPeriodEnd)}
              />
            )}
            {subscription.trialEnd && (
              <DefinitionRow term="Trial ends" value={formatTimestamp(subscription.trialEnd)} />
            )}
          </div>
        )}

        <div className="ns-billing__actions">
          {!isPro && (
            <Button
              variant="primary"
              loading={busy === 'checkout'}
              onClick={() => void startCheckout()}
            >
              Upgrade to Pro
            </Button>
          )}
          {subscription.hasBillingAccount && (
            <Button loading={busy === 'portal'} onClick={() => void openPortal()}>
              Manage subscription
            </Button>
          )}
        </div>

        {subscription.hasBillingAccount && (
          <p className="ns-billing__note">
            Manage subscription opens Stripe&rsquo;s billing portal, where you can update your card,
            download invoices, or cancel. Cancelling takes effect at the end of the period you have
            already paid for — you keep Pro until then, and nothing is pro-rated away.
          </p>
        )}
      </Panel>

      <PlanComparison />

      <Panel title="About billing">
        <ul className="ns-billing__facts">
          <li>Payments are handled entirely by Stripe. NetShift never sees or stores your card.</li>
          <li>
            Cancel any time from the billing portal. There is no cancellation flow to click through
            and no phone call.
          </li>
          <li>
            Cancelling keeps Pro until the end of the period you have paid for, then drops you to
            the free plan. Your data stays exactly where it is.
          </li>
          <li>
            If a payment fails, Pro stays on for a short grace period while Stripe retries, so a
            declined card does not lock you out mid-paycheck.
          </li>
        </ul>
      </Panel>
    </>
  );
}

/** The free vs Pro table, grouped by area and shown to everyone. */
function PlanComparison() {
  const { isPro } = useEntitlement();
  const byArea = new Map<string, FeatureDefinition[]>();
  for (const feature of Object.values(FEATURES)) {
    const list = byArea.get(feature.area) ?? [];
    list.push(feature);
    byArea.set(feature.area, list);
  }

  const AREA_LABELS: Record<string, string> = {
    calculators: 'Calculators',
    'pay-profile': 'Pay profile',
    hours: 'Hours',
    'paycheck-plan': 'Paycheck planning',
    'paycheck-audit': 'Paycheck audit',
    paychecks: 'Paychecks',
    'shift-value': 'Shift value',
    goals: 'Goals',
    buffer: 'Income buffer',
    debt: 'Debt payoff',
    rotations: 'Rotations',
    bonuses: 'Bonuses',
    investments: 'Investments',
    'market-reports': 'Market reports',
    documents: 'Documents',
    settings: 'Your data',
  };

  return (
    <Panel
      title="What each plan includes"
      description="Everything on the free plan stays free. Pro adds planning, history, and automation."
    >
      <div className="ns-plans">
        <div className="ns-plans__col">
          <h4>Free</h4>
          <p className="ns-plans__price">No card required</p>
          <ul>
            <li>Limit of {PLAN_LIMITS.free.payProfiles} pay profile</li>
            <li>Limit of {PLAN_LIMITS.free.activeGoals} active goal</li>
            <li>Current and next paycheck plan</li>
            <li>Last {PLAN_LIMITS.free.paycheckHistory} paychecks kept</li>
          </ul>
        </div>
        <div className="ns-plans__col ns-plans__col--pro">
          <h4>Pro {isPro && <Badge tone="green">Your plan</Badge>}</h4>
          <p className="ns-plans__price">Billed monthly through Stripe</p>
          <ul>
            <li>Unlimited goals and paycheck history</li>
            <li>Plan as many future paychecks as you like</li>
            <li>Recurring bills and saved scenarios</li>
            <li>A higher monthly document-parsing allowance</li>
          </ul>
        </div>
      </div>

      <div className="ns-plans__matrix">
        {[...byArea.entries()].map(([area, features]) => (
          <section key={area}>
            <h4 className="ns-plans__area">{AREA_LABELS[area] ?? area}</h4>
            <ul className="ns-plans__features">
              {features.map((feature) => (
                <li key={feature.key}>
                  <span className="ns-plans__feature-name">
                    {feature.name}
                    <span className="ns-plans__feature-desc">{feature.description}</span>
                  </span>
                  <Badge tone={feature.tier === 'pro' ? 'amber' : 'green'}>
                    {feature.tier === 'pro' ? 'Pro' : 'Free'}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  );
}
