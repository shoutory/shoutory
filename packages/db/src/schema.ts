import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Table metadata for the typed query builder. The migration files are the source of truth for the database; a
// test compares this file with the migrated catalog.
export const app = pgSchema("app");
export const auth = pgSchema("auth");

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const stamp = (name: string) => timestamp(name, { withTimezone: true });

export const schemaMigrations = app.table("schema_migrations", {
  name: text("name").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: stamp("applied_at").notNull().defaultNow(),
});

// Identity tables: the authentication library's, reached only through the auth role.
export const authUser = auth.table("user", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: stamp("created_at").notNull().defaultNow(),
  updatedAt: stamp("updated_at").notNull().defaultNow(),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
});

const userId = () =>
  uuid("user_id")
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" });

export const authSession = auth.table("session", {
  id: id(),
  expiresAt: stamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: stamp("created_at").notNull().defaultNow(),
  updatedAt: stamp("updated_at").notNull().defaultNow(),
  ipHmac: text("ip_hmac"),
  userAgent: text("user_agent"),
  userId: userId(),
});

export const authAccount = auth.table("account", {
  id: id(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: userId(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: stamp("access_token_expires_at"),
  refreshTokenExpiresAt: stamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: stamp("created_at").notNull().defaultNow(),
  updatedAt: stamp("updated_at").notNull().defaultNow(),
});

export const authVerification = auth.table("verification", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: stamp("expires_at").notNull(),
  createdAt: stamp("created_at").notNull().defaultNow(),
  updatedAt: stamp("updated_at").notNull().defaultNow(),
});

export const authTwoFactor = auth.table("two_factor", {
  id: id(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: userId(),
  verified: boolean("verified"),
  failedVerificationCount: integer("failed_verification_count").default(0),
  lockedUntil: stamp("locked_until"),
});

// Throttle and step-up state: written only through definer functions.
export const rateBuckets = app.table(
  "rate_buckets",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    tokens: doublePrecision("tokens").notNull(),
    refilledAt: stamp("refilled_at").notNull().default(sql`clock_timestamp()`),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })],
);

export const sessionStepUps = app.table("session_step_ups", {
  sessionId: uuid("session_id").notNull(),
  userId: userId(),
  method: text("method").notNull(),
  at: stamp("at").notNull().default(sql`clock_timestamp()`),
});

export const userProfiles = app.table("user_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUser.id, { onDelete: "cascade" }),
  lastWorkspaceId: uuid("last_workspace_id"),
  passwordRecheckAt: stamp("password_recheck_at"),
});

export const instanceAdmins = app.table("instance_admins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUser.id, { onDelete: "cascade" }),
  grantedBy: uuid("granted_by"),
  grantedAt: stamp("granted_at").notNull().defaultNow(),
});
