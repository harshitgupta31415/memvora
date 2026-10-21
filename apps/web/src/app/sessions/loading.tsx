import styles from './directory.module.css';

export default function InvestigationsLoading() {
  return (
    <section
      className={`panel ${styles.loading}`}
      aria-label="Investigation directory"
      aria-busy="true"
    >
      <h2>Loading investigations</h2>
      <p className={styles.caption} role="status">
        Reading the requested investigation page and repository filters…
      </p>
    </section>
  );
}
