/** The connection states of a channel; the `channels.connection_state` check constraint lists the same five. */
export const CONNECTION_STATES = [
  "connected",
  "needs_reconnect",
  "disconnected",
  "revoked_by_provider",
  "disabled",
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];
