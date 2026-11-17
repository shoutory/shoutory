import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

// Table metadata for the typed query builder. The migration files are the source of truth for the database.
export const app = pgSchema("app");

export const schemaMigrations = app.table("schema_migrations", {
  name: text("name").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});
