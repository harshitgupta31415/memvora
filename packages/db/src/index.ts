import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export * from './schema.js';
export * from './sqlite-store.js';
export * from './local-config.js';
export * from './local-backup.js';

/** Lazy factory: importing this package never connects to PostgreSQL. */
export function createDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://.');
  }
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
