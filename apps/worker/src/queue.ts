import { PgBoss } from 'pg-boss';

/** Does not start or consume the queue. Handlers require a durable evidence pipeline first. */
export function createQueue(connectionString: string) {
  return new PgBoss(connectionString);
}
