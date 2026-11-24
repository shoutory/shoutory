-- Two more reasons a person is asked to look at an operation: an unknown outcome with no id to read back (`no_remote_id`: the
-- answer of the send was lost, so there is nothing the provider could be asked about) and an unknown outcome whose channel
-- has no usable credential to read it back with (`credential_unavailable`). The reason check is replaced with the longer list
-- of `needs_human`; every row that satisfied the old check satisfies the new one. The new check is added NOT VALID here (it
-- guards every new row at once) and validated in the next file, so no long lock is held on the table.
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
