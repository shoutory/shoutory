import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  doublePrecision,
  integer,
  interval,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// The migration files are the source of truth for the database; a test compares this file with the migrated catalog.
export const app = pgSchema("app");
export const auth = pgSchema("auth");

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const stamp = (name: string) => timestamp(name, { withTimezone: true });

export const schemaMigrations = app.table("schema_migrations", {
  name: text("name").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: stamp("applied_at").notNull().defaultNow(),
});

// The authentication library's tables, reached only through the auth role.
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

// Written only through definer functions.
export const rateBuckets = app.table(
  "rate_buckets",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    tokens: doublePrecision("tokens").notNull(),
    refilledAt: stamp("refilled_at").notNull().default(sql`clock_timestamp()`),
    pausedUntil: stamp("paused_until"),
    pauseReason: text("pause_reason"),
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

// Written and read only through definer functions. The sealed link columns are NULL after send.
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

// The runtime role reads these tables; organization and membership writes come from definer functions.
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

// Partitioned by month on `at`, leaf partitions not declared; written only through the audit definers. The head
// table holds the last hash of each chain (a workspace and a UTC day).
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

// Partitioned by day on `created_at`, leaves not declared, reached only through definers. `xid` is the writer's
// transaction id (xid8), the relay's visibility cursor together with the id.
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

// Rows come from connect definers; the app role writes the nickname only.
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
  disabledFromState: text("disabled_from_state"),
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

// Definer-only; the client secret is stored sealed.
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

// One salt per workspace wraps every credential's data key, so deleting it shreds them; definer-only.
export const workspaceKeySalts = app.table("workspace_key_salts", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  salt: bytea("salt").notNull(),
  createdAt: stamp("created_at").notNull().default(sql`clock_timestamp()`),
});

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
  refreshSweptAt: stamp("refresh_swept_at"),
});

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

export const connectChallenges = app.table("connect_challenges", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  providerId: text("provider_id").notNull(),
  codeHash: bytea("code_hash").notNull(),
  expiresAt: stamp("expires_at").notNull(),
  consumedAt: stamp("consumed_at"),
});

// Written only by the media definers.
export const mediaAssets = app.table("media_assets", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  objectKey: text("object_key").notNull(),
  fileName: text("file_name").notNull(),
  mime: text("mime"),
  byteSize: bigint("byte_size", { mode: "number" }),
  width: integer("width"),
  height: integer("height"),
  durationMs: integer("duration_ms"),
  codecFacts: jsonb("codec_facts"),
  sha256: bytea("sha256"),
  state: text("state").notNull().default("pending_upload"),
  rejectReason: text("reject_reason"),
  inLibrary: boolean("in_library").notNull().default(false),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  source: text("source").notNull(),
  sourceRef: text("source_ref"),
  createdBy: uuid("created_by").notNull(),
  createdAt: stamp("created_at").notNull().default(sql`clock_timestamp()`),
  deletedAt: stamp("deleted_at"),
  objectRemovedAt: stamp("object_removed_at"),
});

export const mediaUploads = app.table("media_uploads", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  mediaId: uuid("media_id").notNull(),
  multipartUploadId: text("multipart_upload_id"),
  partSize: integer("part_size"),
  partsDone: integer("parts_done").array(),
  // The sha256 and size of the whole file as its sender declared them; set once with the upload id.
  declaredSha256: bytea("declared_sha256"),
  declaredSize: bigint("declared_size", { mode: "number" }),
  expiresAt: stamp("expires_at").notNull(),
  completedAt: stamp("completed_at"),
});

export const mediaDerivatives = app.table("media_derivatives", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  mediaId: uuid("media_id").notNull(),
  profile: text("profile").notNull(),
  objectKey: text("object_key").notNull(),
  state: text("state").notNull().default("pending"),
  sha256: bytea("sha256"),
  byteSize: bigint("byte_size", { mode: "number" }),
  error: text("error"),
});

// Its text lives in the variants and `currentVersionId` is its ETag. Written only by the post definers.
export const posts = app.table("posts", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  authorKind: text("author_kind").notNull(),
  authorId: uuid("author_id").notNull(),
  origin: text("origin").notNull().default("ui"),
  status: text("status").notNull().default("draft"),
  targetsTotal: integer("targets_total").notNull().default(0),
  targetsPublished: integer("targets_published").notNull().default(0),
  targetsPublishedNotLive: integer("targets_published_not_live").notNull().default(0),
  currentVersionId: uuid("current_version_id"),
  firstDueAt: stamp("first_due_at"),
  publishedAt: stamp("published_at"),
  deletedAt: stamp("deleted_at"),
  createdAt: stamp("created_at").notNull().default(sql`clock_timestamp()`),
  updatedAt: stamp("updated_at").notNull().default(sql`clock_timestamp()`),
});

// Inserted once, never changed. The snapshot holds the draft the variants are rebuilt from.
export const postVersions = app.table("post_versions", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  postId: uuid("post_id").notNull(),
  versionNo: integer("version_no").notNull(),
  kind: text("kind").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  snapshotHash: bytea("snapshot_hash").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: stamp("created_at").notNull().default(sql`clock_timestamp()`),
});

// The wall-clock time of a due date, without a zone: the zone is `due_tz`.
const localStamp = customType<{ data: string }>({ dataType: () => "timestamp without time zone" });

export const postVariants = app.table("post_variants", {
  id: id(),
  workspaceId: uuid("workspace_id").notNull(),
  postId: uuid("post_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  locale: text("locale"),
  postType: text("post_type").notNull().default("text"),
  text: text("text").notNull().default(""),
  parts: jsonb("parts").notNull().default(sql`'[]'`),
  settings: jsonb("settings").notNull().default(sql`'{}'`),
  scheduleState: text("schedule_state").notNull().default("draft"),
  localDue: localStamp("local_due"),
  dueTz: text("due_tz"),
  dueAt: stamp("due_at"),
  frozenVersionId: uuid("frozen_version_id"),
  presence: text("presence").notNull().default("present"),
  externalId: text("external_id"),
  permalink: text("permalink"),
  publishedAt: stamp("published_at"),
  createdAt: stamp("created_at").notNull().default(sql`clock_timestamp()`),
  updatedAt: stamp("updated_at").notNull().default(sql`clock_timestamp()`),
});

export const postMedia = app.table(
  "post_media",
  {
    workspaceId: uuid("workspace_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    position: smallint("position").notNull(),
    mediaId: uuid("media_id").notNull(),
    altText: text("alt_text"),
    crop: jsonb("crop"),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.variantId, table.position] })],
);

export const idempotencyKeys = app.table(
  "idempotency_keys",
  {
    workspaceId: uuid("workspace_id").notNull(),
    principalKind: text("principal_kind").notNull(),
    principalId: uuid("principal_id").notNull(),
    key: text("key").notNull(),
    requestHash: bytea("request_hash").notNull(),
    state: text("state").notNull().default("in_flight"),
    inFlightUntil: stamp("in_flight_until").notNull().default(sql`clock_timestamp() + interval '60 seconds'`),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    resourceIds: jsonb("resource_ids"),
    expiresAt: stamp("expires_at").notNull().default(sql`clock_timestamp() + interval '24 hours'`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.principalKind, table.principalId, table.key] }),
  ],
);
