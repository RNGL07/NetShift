import type { ReactNode } from 'react';
import { TierBadge } from './ProGate';
import type { FeatureKey } from '@/config/plans';

/**
 * Every page's heading.
 *
 * Carries the tier badge next to the title, so "is this free or Pro?" is
 * answered on arrival rather than on first click.
 */
export function PageHeader({
  title,
  description,
  feature,
  actions,
}: {
  title: string;
  description?: ReactNode;
  feature?: FeatureKey;
  actions?: ReactNode;
}) {
  return (
    <header className="ns-page-head">
      <div className="ns-page-head__title">
        <h1>{title}</h1>
        {feature && <TierBadge feature={feature} />}
        {actions && <div style={{ marginLeft: 'auto' }}>{actions}</div>}
      </div>
      {description && <p className="ns-page-head__desc">{description}</p>}
    </header>
  );
}
