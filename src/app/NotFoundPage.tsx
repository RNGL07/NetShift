import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/ui';

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found" icon="?">
      That page does not exist. <Link to="/">Go back to your dashboard</Link>.
    </EmptyState>
  );
}
