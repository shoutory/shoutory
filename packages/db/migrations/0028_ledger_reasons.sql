-- NOT VALID so no long lock is held; validated in the next file. Every row that satisfied the old check satisfies this
-- one.
ALTER TABLE app.operations DROP CONSTRAINT operations_reason_check;
ALTER TABLE app.operations ADD CONSTRAINT operations_reason_check CHECK (CASE state
    WHEN 'paused' THEN reason_code IS NULL OR reason_code IN ('quota', 'entitlement', 'provider_cooldown',
      'capability_withdrawn', 'api_sunset', 'channel_disabled')
    WHEN 'blocked_reconnect' THEN coalesce(reason_code IN ('pending', 'provider_accepted', 'unknown_external_state'), false)
    WHEN 'provider_accepted' THEN reason_code IS NULL OR reason_code = 'awaiting_user_action'
    WHEN 'needs_human' THEN reason_code IS NULL OR reason_code IN ('past_due_after_reconnect', 'awaiting_user_timeout',
      'media_unreachable', 'no_remote_id', 'credential_unavailable')
    WHEN 'cancelled' THEN reason_code IS NULL OR reason_code IN ('policy', 'workspace_deleted')
    ELSE reason_code IS NULL END) NOT VALID;
