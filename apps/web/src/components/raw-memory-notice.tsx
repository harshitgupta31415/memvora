import Link from 'next/link';
import type { Memory } from '@memvora/contracts';
import { StatusBadge } from './ui';
import styles from './raw-memory-notice.module.css';

export function RawMemoryNotice({
  memory,
  compact = false,
}: {
  memory: Memory;
  compact?: boolean;
}) {
  if (memory.representation !== 'raw_event') return null;
  return (
    <div className={compact ? styles.compact : styles.notice}>
      <strong>Original captured evidence</strong>
      <div className={styles.processing}>
        <span>Summary processing</span>
        {memory.processingStatus ? (
          <StatusBadge status={memory.processingStatus} />
        ) : (
          <span>State unavailable</span>
        )}
      </div>
      {!compact && (
        <p>
          This view is computed from the accepted event when read. No stored summary is available
          for this event; the original command remains the source of evidence.
        </p>
      )}
      <div className={styles.links}>
        <Link
          href={`/events/${encodeURIComponent(memory.id)}`}
          className="inline-link"
          prefetch={false}
        >
          Open original command
        </Link>
        {!compact && (
          <Link
            href={`/jobs?sessionId=${encodeURIComponent(memory.sessionId)}`}
            className="inline-link"
            prefetch={false}
          >
            View summary processing
          </Link>
        )}
      </div>
    </div>
  );
}
