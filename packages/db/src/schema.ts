import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Draft scaffold only: no migration has been generated or applied. */
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  githubUserId: text('github_user_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Ownership is a foundation, not an implemented authorization policy. */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
