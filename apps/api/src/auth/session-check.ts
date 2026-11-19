import type { BetterAuthInstance } from "./auth.js";
import { sessionCookies, withoutForgedSession } from "./cookie.js";
import { refusalFromThrown } from "./error-map.js";

export interface AuthSession {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly expiresAt: Date;
}

export interface ResolvedSession {
  readonly session: AuthSession;
  /** The `Set-Cookie` lines the check produced (a sliding refresh), to be sent with the answer. */
  readonly cookies: readonly string[];
}

/** Reads the session from the request's cookie; nothing when there is none or it is expired or unknown. */
export type SessionResolver = (headers: Headers) => Promise<ResolvedSession | null>;

/** The session check of every `session` route. A failing database is a 503 (the cause chain is read), never a 401. */
export async function readSession(
  library: BetterAuthInstance,
  headers: Headers,
): Promise<ResolvedSession | null> {
  try {
    const found = await library.api.getSession({
      headers: withoutForgedSession(headers),
      returnHeaders: true,
    });
    if (!found.response) return null;
    const { session, user } = found.response;
    return {
      session: {
        id: session.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        expiresAt: session.expiresAt,
      },
      cookies: sessionCookies(found.headers),
    };
  } catch (error) {
    throw refusalFromThrown(error);
  }
}
