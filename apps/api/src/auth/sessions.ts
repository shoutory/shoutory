import type { AuthService } from "./auth.js";
import { type AuthSession, SESSION_CAP_MS } from "./session-check.js";

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

const LIST_LIMIT = 100;

interface SessionRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly userAgent?: string | null;
}

export async function listSessions(auth: AuthService, current: AuthSession): Promise<SessionListItem[]> {
  const context = await auth.library.$context;
  const rows = await context.adapter.findMany<SessionRow>({
    model: "session",
    where: [
      { field: "userId", value: current.userId },
      { field: "expiresAt", value: new Date(), operator: "gt" },
      // A session at or over the 30-day cap is already gone to the API: the list does not show it.
      { field: "createdAt", value: new Date(auth.now() - SESSION_CAP_MS), operator: "gt" },
    ],
    sortBy: { field: "createdAt", direction: "desc" },
    limit: LIST_LIMIT,
  });
  if (!rows.some((row) => row.id === current.id)) {
    const own = await context.adapter.findOne<SessionRow>({
      model: "session",
      where: [{ field: "id", value: current.id }],
    });
    if (own) rows.splice(LIST_LIMIT - 1, rows.length, own);
  }
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    userAgent: row.userAgent ?? null,
    current: row.id === current.id,
  }));
}
