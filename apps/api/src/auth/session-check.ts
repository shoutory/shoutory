import type { BetterAuthInstance } from "./auth.js";
import { sessionCookies, withoutForgedSession } from "./cookie.js";
import { refusalFromThrown } from "./error-map.js";

export interface AuthSession {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Read fresh with the session (the library's cookie cache is off), so a change shows at once. */
  readonly twoFactorEnabled: boolean;
  readonly expiresAt: Date;
}

export interface ResolvedSession {
  readonly session: AuthSession;
  /** The `Set-Cookie` lines the check produced (a sliding refresh), to be sent with the answer. */
  readonly cookies: readonly string[];
}

/** Reads the session from the request's cookie; nothing when there is none or it is expired or unknown. */
export type SessionResolver = (headers: Headers) => Promise<ResolvedSession | null>;

/** A session ends 30 days after it was created, however it was used or refreshed (R511). */
export const SESSION_CAP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The session check of every `session` route. A session 30 days old or more is absent and its row is deleted, whatever
 * the library's rolling expiry says. A failing database is a 503 (the cause chain is read), never a 401.
 */
export async function readSession(
  library: BetterAuthInstance,
  headers: Headers,
  now: () => number,
): Promise<ResolvedSession | null> {
  try {
    const found = await library.api.getSession({
      headers: withoutForgedSession(headers),
      returnHeaders: true,
    });
    if (!found.response) return null;
    const { session, user } = found.response;
    // Written so that an age that cannot be computed (NaN) is over the cap: the check fails closed.
    if (!(now() - new Date(session.createdAt).getTime() < SESSION_CAP_MS)) {
      const context = await library.$context;
      await context.adapter.delete({ model: "session", where: [{ field: "id", value: session.id }] });
      return null;
    }
    return {
      session: {
        id: session.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled === true,
        // A refresh may push the stored expiry past the cap; what the session reports never does.
        expiresAt: new Date(
          Math.min(session.expiresAt.getTime(), new Date(session.createdAt).getTime() + SESSION_CAP_MS),
        ),
      },
      cookies: sessionCookies(found.headers),
    };
  } catch (error) {
    throw refusalFromThrown(error);
  }
}
