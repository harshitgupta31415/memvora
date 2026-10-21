import styles from './handover.module.css';

export default function HandoverLoading() {
  return (
    <section
      className={`panel ${styles.panel}`}
      aria-busy="true"
      aria-label="Portable handover report"
    >
      <h2>Preparing your handover report</h2>
      <p className={styles.caption} role="status">
        Reading the investigation’s accepted evidence and author reports…
      </p>
    </section>
  );
}
