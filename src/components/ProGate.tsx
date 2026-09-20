/**
 * Locked-feature presentation.
 *
 * A locked feature shows an informative preview rather than vanishing: a user
 * who cannot see that debt scenarios exist cannot decide whether they are
 * worth paying for, and a disappearing button reads as a bug.
 *
 * This is presentation only. The same rule is enforced on the server, and the
 * underlying rows are protected by row-level security, so revealing the
 * *shape* of a Pro feature reveals nothing and costs nothing.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FEATURES, type FeatureKey } from '@/config/plans';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import { Badge, Button, Callout } from '@/components/ui';
import './pro-gate.css';

export function ProBadge() {
  return (
    <Badge tone="amber" title="Part of NetShift Pro">
      Pro
    </Badge>
  );
}

export function FreeBadge() {
  return (
    <Badge tone="green" title="Included on the free plan">
      Free
    </Badge>
  );
}

/** The badge that matches a feature's tier, for labelling nav and headings. */
export function TierBadge({ feature }: { feature: FeatureKey }) {
  return FEATURES[feature].tier === 'pro' ? <ProBadge /> : <FreeBadge />;
}

/**
 * Renders `children` when the user's tier covers `feature`, and a preview
 * otherwise.
 *
 * `preview` is the blurred-but-visible version of the feature. When none is
 * given, a description of what the feature does is shown instead — never an
 * empty space.
 */
export function ProGate({
  feature,
  children,
  preview,
  compact = false,
}: {
  feature: FeatureKey;
  children: ReactNode;
  preview?: ReactNode;
  compact?: boolean;
}) {
  const { can } = useEntitlement();
  const definition = FEATURES[feature];

  if (can(feature)) return <>{children}</>;

  if (compact) {
    return (
      <Callout tone="neutral" icon="P">
        <strong>{definition.name}</strong> is part of NetShift Pro.{' '}
        <Link to="/billing">See what Pro includes</Link>.
      </Callout>
    );
  }

  return (
    <div className="ns-gate">
      {preview && (
        <div className="ns-gate__preview" aria-hidden="true">
          {preview}
        </div>
      )}
      <div className="ns-gate__overlay">
        <div className="ns-gate__card">
          <ProBadge />
          <h4 className="ns-gate__title">{definition.name}</h4>
          <p className="ns-gate__desc">{definition.description}</p>
          <Link to="/billing" className="ns-btn ns-btn--primary ns-gate__link">
            Upgrade to Pro
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * A button that becomes an upgrade prompt for free users.
 *
 * The button stays visible and keeps its label, so the action is discoverable;
 * pressing it explains the limit rather than failing silently.
 */
export function ProAction({
  feature,
  children,
  onClick,
  ...rest
}: {
  feature: FeatureKey;
  children: ReactNode;
  onClick: () => void;
} & Omit<Parameters<typeof Button>[0], 'onClick' | 'children'>) {
  const { can } = useEntitlement();
  const allowed = can(feature);

  if (allowed) {
    return (
      <Button onClick={onClick} {...rest}>
        {children}
      </Button>
    );
  }

  return (
    <Button
      {...rest}
      variant="ghost"
      title={`${FEATURES[feature].name} is part of NetShift Pro`}
      onClick={() => {
        window.location.assign('/billing');
      }}
    >
      {children} <ProBadge />
    </Button>
  );
}

/** Explains a free-tier quantity limit at the point it is hit. */
export function LimitNotice({
  reached,
  limitLabel,
  featureName,
}: {
  reached: boolean;
  limitLabel: string;
  featureName: string;
}) {
  if (!reached) return null;
  return (
    <Callout tone="warning" icon="!">
      You have reached the free plan&rsquo;s limit of {limitLabel}. NetShift Pro removes the cap on{' '}
      {featureName}. <Link to="/billing">See plans</Link>.
    </Callout>
  );
}
