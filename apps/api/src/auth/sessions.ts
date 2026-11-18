import type { AuthService } from "./auth.js";
import type { AuthSession } from "./session-check.js";

export interface SessionListItem {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly current: boolean;
}

/** Ends one of the user's own sessions by its row id; another user's id matches nothing and answers the same. */
export async function revokeSession(auth: AuthService, current: AuthSession, id: string): Promise<void> {
  const context = await auth.library.$context;
  await context.adapter.delete({
    model: "session",
    where: [
      { field: "id", value: id },
      { field: "userId", value: current.userId },
    ],
  });
}

/** Ends every session of the user except the one making the request. */
export async function revokeOtherSessions(auth: AuthService, current: AuthSession): Promise<void> {
  const context = await auth.library.$context;
  await context.adapter.deleteMany({
    model: "session",
    where: [
      { field: "userId", value: current.userId },
      { field: "id", value: current.id, operator: "ne" },
    ],
  });
}

/** The user's live sessions by row id. The stored token digest and the address digest are never part of an item. */
export async function listSessions(auth: AuthService, current: AuthSession): Promise<SessionListItem[]> {
  const context = await auth.library.$context;
  const rows = await context.internalAdapter.listSessions(current.userId);
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    userAgent: row.userAgent ?? null,
    current: row.id === current.id,
  }));
}
