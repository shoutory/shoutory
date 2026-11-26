# Data categories

This page lists the kinds of data Shoutory keeps, and which kind each database table holds. A privacy policy for a
Shoutory instance can be written from it. A test in `packages/db` compares the table below with the migrated database:
it fails when a table has no row here, when a row names a table that does not exist, when a table is listed twice, or
when a row names a category that is not in the list.

## Categories

- `account`: who a person is to the instance: email address, password hash, sessions, two-factor secrets and
  recovery codes, profile settings, and the mail sent to them.
- `tenancy`: organizations, workspaces, members, roles and invitations.
- `content`: posts, their versions and variants, media files, and the publishing work done for them.
- `channel-credentials`: the access tokens of connected social accounts, always encrypted (AES-256-GCM envelope).
- `platform-data`: what is read back from a social network: the connected account's name, handle and picture, and the
  links and ids of published posts.
- `audit`: the audit log, who did what and when, and the notes people write when they resolve a stuck post.
- `ip-address`: IP addresses and the other keys that rate limits count by (an email address, an account), kept only
  as a keyed HMAC, never in clear. Sessions and the audit log also hold a client IP this way.
- `portal-contacts`: the email and display name of an outside reviewer (no table yet).
- `ai-keys`: a workspace's own AI provider key, always sealed (no table yet).
- `secrets`: the client secrets of the provider apps the instance registers, always sealed.
- `none`: no personal data: settings, counters, queues and bookkeeping.

## Tables

| table | category |
|---|---|
| `auth.user` | `account` |
| `auth.account` | `account` |
| `auth.session` | `account` |
| `auth.two_factor` | `account` |
| `auth.verification` | `account` |
| `app.user_profiles` | `account` |
| `app.session_step_ups` | `account` |
| `app.instance_admins` | `account` |
| `app.email_outbox` | `account` |
| `app.email_suppressions` | `account` |
| `app.organizations` | `tenancy` |
| `app.workspaces` | `tenancy` |
| `app.organization_members` | `tenancy` |
| `app.workspace_members` | `tenancy` |
| `app.roles` | `tenancy` |
| `app.invitations` | `tenancy` |
| `app.posts` | `content` |
| `app.post_versions` | `content` |
| `app.post_variants` | `content` |
| `app.post_media` | `content` |
| `app.media_assets` | `content` |
| `app.media_derivatives` | `content` |
| `app.media_uploads` | `content` |
| `app.operations` | `content` |
| `app.operation_attempts` | `content` |
| `app.operation_media` | `content` |
| `app.idempotency_keys` | `content` |
| `app.channel_credentials` | `channel-credentials` |
| `app.oauth_flows` | `channel-credentials` |
| `app.channels` | `platform-data` |
| `app.operation_evidence` | `platform-data` |
| `app.audit_logs` | `audit` |
| `app.audit_heads` | `audit` |
| `app.operation_resolutions` | `audit` |
| `app.provider_apps` | `secrets` |
| `app.provider_instance_apps` | `secrets` |
| `app.channel_capability_snapshots` | `none` |
| `app.connect_challenges` | `none` |
| `app.feature_flags` | `none` |
| `app.feature_flag_overrides` | `none` |
| `app.instance_settings` | `none` |
| `app.ledger_transitions` | `none` |
| `app.outbox` | `none` |
| `app.provider_quota_ledger` | `platform-data` |
| `app.rate_buckets` | `ip-address` |
| `app.retention_classes` | `none` |
| `app.schema_migrations` | `none` |
| `app.sync_cursors` | `none` |
| `app.usage_reservations` | `none` |
| `app.worker_heartbeats` | `none` |
| `app.workspace_key_salts` | `none` |
