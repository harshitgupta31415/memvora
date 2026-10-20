'use client';

import { Icon } from '@/components/icon';

export default function Error({ reset }: { reset: () => void }) {
  return (
    <section className="empty-state error-boundary" role="alert">
      <span className="empty-icon">
        <Icon name="alert" size={28} />
      </span>
      <h1>This view could not be loaded.</h1>
      <p>Try again to reload your workspace. This does not delete your recorded evidence.</p>
      <button className="button button-primary" onClick={reset}>
        <Icon name="refresh" size={16} />
        Try again
      </button>
    </section>
  );
}
