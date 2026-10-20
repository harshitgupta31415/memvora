import Link from 'next/link';
import { EmptyState } from '@/components/ui';

export default function NotFound() {
  return (
    <EmptyState
      icon="search"
      title="This record is not here."
      description="It may have been removed, or the link may belong to another workspace."
      action={
        <Link className="button button-primary" href="/">
          Back to overview
        </Link>
      }
    />
  );
}
