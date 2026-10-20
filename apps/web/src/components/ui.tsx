import Link from 'next/link';
import { Icon, type IconName } from './icon';

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon = 'terminal',
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  message = 'The local API could not be reached.',
  detail,
}: {
  message?: string;
  detail?: string;
}) {
  return (
    <section className="notice notice-error" role="alert">
      <Icon name="alert" size={20} />
      <div>
        <strong>{message}</strong>
        <p>
          {detail ??
            'Start the API with npm run dev, then refresh this page. Your stored evidence remains in its local database.'}
        </p>
        <Link href="/settings" className="inline-link">
          Check connection settings <Icon name="arrow" size={14} />
        </Link>
      </div>
    </section>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const positive = ['ready', 'completed', 'check_passed', 'closed', 'active'].includes(status);
  const negative = ['failed', 'spawn_failed', 'interrupted', 'denied', 'incomplete'].includes(
    status,
  );
  return (
    <span
      className={`status-badge ${positive ? 'status-positive' : negative ? 'status-negative' : 'status-neutral'}`}
    >
      <span />
      {status.replaceAll('_', ' ')}
    </span>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function DateLabel({ value, relative = false }: { value: string; relative?: boolean }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span>Unknown time</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {date.toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: relative ? undefined : 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      })}
    </time>
  );
}
