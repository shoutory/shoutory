import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  date,
  doublePrecision,
  integer,
  interval,
  jsonb,
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

// The sealed fields of a stored secret are raw bytes; Drizzle has no bytea builder at the pin.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// The mail outbox: written and read only through definer functions. The sealed link columns are NULL after send.
export const emailOutbox = app.table("email_outbox", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id"),
  recipient: text("recipient").notNull(),
  template: text("template").notNull(),
  locale: text("locale").notNull(),
  vars: jsonb("vars").notNull(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: stamp("next_attempt_at").notNull().default(sql`clock_timestamp()`),
  createdAt: stamp("created_at").notNull().default(sql`clock_timestamp()`),
  linkCiphertext: bytea("link_ciphertext"),
  linkIv: bytea("link_iv"),
  linkAuthTag: bytea("link_auth_tag"),
  linkWrapIv: bytea("link_wrap_iv"),
  linkWrapTag: bytea("link_wrap_tag"),
  linkWrappedDek: bytea("link_wrapped_dek"),
  linkKeyId: text("link_key_id"),
  linkFormatVersion: integer("link_format_version"),
  linkGeneration: integer("link_generation"),
  linkDigest: text("link_digest"),
  claimedUntil: stamp("claimed_until"),
});

export const instanceAdmins = app.table("instance_admins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUser.id, { onDelete: "cascade" }),
  grantedBy: uuid("granted_by"),
  grantedAt: stamp("granted_at").notNull().defaultNow(),
});

// Tenancy: the runtime role reads these tables; organization and membership writes come from definer functions.
export const organizations = app.table("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  type: text("type").notNull(),
  region: text("region").notNull().default("default"),
  planRef: text("plan_ref"),
  deletionRequestedAt: stamp("deletion_requested_at"),
});

export const organizationMembers = app.table(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: userId(),
    orgRole: text("org_role").notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

export const workspaces = app.table("workspaces", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  colour: text("colour"),
  avatar: uuid("avatar"),
  defaultTz: text("default_tz").notNull().default("UTC"),
  latenessTolerance: interval("lateness_tolerance").notNull().default("2 hours"),
  region: text("region").notNull().default("default"),
  deletionRequestedAt: stamp("deletion_requested_at"),
  archivedAt: stamp("archived_at"),
});

// workspaceId is NULL for a built-in role.
export const roles = app.table("roles", {
  id: id(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  permissions: text("permissions").array().notNull(),
});

export const workspaceMembers = app.table("workspace_members", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: userId(),
  roleId: uuid("role_id")
    .notNull()
    .references(() => roles.id),
  status: text("status").notNull().default("active"),
});

// Written only by the invitation definers; the runtime role reads every column but the digest.
export const invitations = app.table("invitations", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  roleId: uuid("role_id")
    .notNull()
    .references(() => roles.id),
  tokenHash: bytea("token_hash").notNull(),
  expiresAt: stamp("expires_at").notNull(),
  acceptedAt: stamp("accepted_at"),
  acceptedBy: uuid("accepted_by").references(() => authUser.id),
  revokedAt: stamp("revoked_at"),
  invitedBy: uuid("invited_by")
    .notNull()
    .references(() => authUser.id),
});

export const instanceSettings = app.table("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: stamp("updated_at").notNull().default(sql`clock_timestamp()`),
});

// Read and written only through the flag definers; no runtime role holds a privilege on either table.
export const featureFlags = app.table("feature_flags", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
  owner: text("owner").notNull(),
  removeBy: date("remove_by").notNull(),
  defaultOn: boolean("default_on").notNull().default(false),
});

export const featureFlagOverrides = app.table("feature_flag_overrides", {
  id: id(),
  flagKey: text("flag_key")
    .notNull()
    .references(() => featureFlags.key, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  scopeId: uuid("scope_id"),
  on: boolean("on").notNull(),
});

// The audit log is partitioned by month on `at` and written only through the audit definers; its leaf partitions
// are not declared. The head table holds the last hash of each chain (a workspace and a UTC day).
export const auditLogs = app.table(
  "audit_logs",
  {
    id: uuid("id").notNull().default(sql`uuidv7()`),
    at: stamp("at").notNull(),
    workspaceId: uuid("workspace_id"),
    organizationId: uuid("organization_id"),
    actorKind: text("actor_kind").notNull(),
    actorRef: text("actor_ref").notNull(),
    action: text("action").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    requestId: text("request_id"),
    ipHmac: bytea("ip_hmac"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'`),
    prevHash: bytea("prev_hash").notNull(),
    hash: bytea("hash").notNull(),
  },
  (table) => [primaryKey({ columns: [table.at, table.id] })],
);

// The event outbox: partitioned by day on `created_at`, leaves not declared, reached only through definers. `xid` is
// the writer's transaction id (xid8), the relay's visibility cursor together with the id.
const xid8 = customType<{ data: string }>({ dataType: () => "xid8" });
export const outbox = app.table(
  "outbox",
  {
    id: uuid("id").notNull().default(sql`uuidv7()`),
    createdAt: stamp("created_at").notNull().default(sql`clock_timestamp()`),
    xid: xid8("xid").notNull().default(sql`pg_current_xact_id()`),
    workspaceId: uuid("workspace_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'`),
    dispatchedAt: stamp("dispatched_at"),
    claimedUntil: stamp("claimed_until"),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.createdAt, table.id] })],
);

export const workerHeartbeats = app.table("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  role: text("role").notNull(),
  startedAt: stamp("started_at").notNull().default(sql`clock_timestamp()`),
  seenAt: stamp("seen_at").notNull().default(sql`clock_timestamp()`),
});

export const emailSuppressions = app.table("email_suppressions", {
  emailDigest: text("email_digest").primaryKey(),
  reason: text("reason").notNull(),
  createdAt: stamp("created_at").notNull().default(sql`clock_timestamp()`),
});

export const retentionClasses = app.table("retention_classes", {
  class: text("class").primaryKey(),
  tableName: text("table_name").notNull(),
  kind: text("kind").notNull(),
  eventColumn: text("event_column"),
  retain: interval("retain").notNull(),
  partitionUnit: text("partition_unit"),
});

export const auditHeads = app.table("audit_heads", {
  id: id(),
  workspaceId: uuid("workspace_id"),
  day: date("day").notNull(),
  headHash: bytea("head_hash").notNull(),
});

// Channels: a connected account of a workspace. Rows come from connect definers; the app role writes the nickname only.
export const channels = app.table("channels", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  providerId: text("provider_id").notNull(),
  accountKind: text("account_kind").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  instanceHost: text("instance_host"),
  displayName: text("display_name").notNull(),
  handle: text("handle"),
  nickname: text("nickname"),
  avatar: text("avatar"),
  connectionState: text("connection_state").notNull().default("needs_reconnect"),
  stateReason: text("state_reason"),
  health: text("health"),
  healthCheckedAt: stamp("health_checked_at"),
  disconnectedAt: stamp("disconnected_at"),
  reconnectDeadline: stamp("reconnect_deadline"),
  tokenExpiresAt: stamp("token_expires_at"),
  lastReauthNotice: stamp("last_reauth_notice"),
  capabilityEpoch: integer("capability_epoch").notNull().default(0),
});

export const channelCapabilitySnapshots = app.table(
  "channel_capability_snapshots",
  {
    workspaceId: uuid("workspace_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    epoch: integer("epoch").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    apiVersion: text("api_version").notNull(),
    sunsetAt: stamp("sunset_at"),
    capabilities: jsonb("capabilities").notNull(),
    limits: jsonb("limits").notNull(),
    observedAt: stamp("observed_at").notNull().default(sql`clock_timestamp()`),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.channelId, table.epoch] })],
);

export const syncCursors = app.table(
  "sync_cursors",
  {
    workspaceId: uuid("workspace_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    stream: text("stream").notNull(),
    cursor: text("cursor").notNull(),
    syncedAt: stamp("synced_at"),
    nextSyncAt: stamp("next_sync_at"),
    errorCount: integer("error_count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.channelId, table.stream] })],
);

// The platform's OAuth applications, instance-level and definer-only; the client secret is stored sealed.
const sealedSecret = () => ({
  secretCiphertext: bytea("secret_ciphertext").notNull(),
  secretIv: bytea("secret_iv").notNull(),
  secretAuthTag: bytea("secret_auth_tag").notNull(),
  secretWrapIv: bytea("secret_wrap_iv").notNull(),
  secretWrapTag: bytea("secret_wrap_tag").notNull(),
  secretWrappedDek: bytea("secret_wrapped_dek").notNull(),
  secretKeyId: text("secret_key_id").notNull(),
  secretFormatVersion: integer("secret_format_version").notNull(),
  secretGeneration: integer("secret_generation").notNull(),
});

export const providerApps = app.table("provider_apps", {
  id: id(),
  providerId: text("provider_id").notNull(),
  environment: text("environment").notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  appToken: text("app_token"),
  active: boolean("active").notNull().default(true),
  ...sealedSecret(),
});

export const providerInstanceApps = app.table("provider_instance_apps", {
  id: id(),
  providerId: text("provider_id").notNull(),
  instanceHost: text("instance_host").notNull(),
  clientId: text("client_id").notNull(),
  ...sealedSecret(),
});

// One salt per workspace wraps every credential's data key (crypto-shred); definer-only.
export const workspaceKeySalts = app.table("workspace_key_salts", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  salt: bytea("salt").notNull(),
  createdAt: stamp("created_at").notNull().default(sql`clock_timestamp()`),
});

// The sealed credential of a channel, its refresh lease and attempt marker; definer-only.
export const channelCredentials = app.table("channel_credentials", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  generation: integer("generation").notNull(),
  kind: text("kind").notNull(),
  formatVersion: integer("format_version").notNull(),
  keyId: text("key_id").notNull(),
  iv: bytea("iv").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  authTag: bytea("auth_tag").notNull(),
  wrapIv: bytea("wrap_iv").notNull(),
  wrapTag: bytea("wrap_tag").notNull(),
  wrappedDek: bytea("wrapped_dek").notNull(),
  accessExpiresAt: stamp("access_expires_at"),
  refreshExpiresAt: stamp("refresh_expires_at"),
  refreshTokenDigest: text("refresh_token_digest"),
  state: text("state").notNull().default("active"),
  refreshingUntil: stamp("refreshing_until"),
  refreshOwner: text("refresh_owner"),
  refreshFencing: integer("refresh_fencing").notNull().default(0),
  refreshAttemptDigest: text("refresh_attempt_digest"),
  refreshAttemptOutcome: text("refresh_attempt_outcome"),
});

// An OAuth connect in progress: the state digest and one sealed object (verifier and optional DPoP key); definer-only.
export const oauthFlows = app.table("oauth_flows", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  channelId: uuid("channel_id"),
  instanceHost: text("instance_host"),
  providerId: text("provider_id").notNull(),
  stateHash: bytea("state_hash").notNull(),
  formatVersion: integer("format_version").notNull(),
  keyId: text("key_id").notNull(),
  iv: bytea("iv").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  authTag: bytea("auth_tag").notNull(),
  wrapIv: bytea("wrap_iv").notNull(),
  wrapTag: bytea("wrap_tag").notNull(),
  wrappedDek: bytea("wrapped_dek").notNull(),
  requestUri: text("request_uri"),
  expiresAt: stamp("expires_at").notNull(),
  consumedAt: stamp("consumed_at"),
});

// A chat connect word: the digest of what the chat sends, single use; definer-only.
export const connectChallenges = app.table("connect_challenges", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  providerId: text("provider_id").notNull(),
  codeHash: bytea("code_hash").notNull(),
  expiresAt: stamp("expires_at").notNull(),
  consumedAt: stamp("consumed_at"),
});
