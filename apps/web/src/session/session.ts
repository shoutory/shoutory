import { type LoaderFunctionArgs, redirect } from "react-router";
import { z } from "zod";
import { ApiError, request } from "../http/client";

// `GET /api/auth/get-session` (apps/api auth/mount.ts): the session and the user it belongs to.
const sessionSchema = z.object({
  session: z.object({ id: z.string(), expiresAt: z.string() }),
  user: z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean() }),
});

/** The id of the guarded route: its loader data is the session, read by the screens with `useRouteLoaderData`. */
export const SESSION_ROUTE_ID = "session";

/**
 * The session guard (a route loader). A signed-out visitor is sent to the sign-in page with the page they asked for;
 * any other failure (maintenance, an error answer) goes to the route's error page with its typed state.
 */
export async function sessionGuard({ request: navigation }: LoaderFunctionArgs) {
  try {
    return await request(sessionSchema, "/api/auth/get-session");
  } catch (error) {
    if (error instanceof ApiError && error.state === "session_expired") {
      const asked = new URL(navigation.url);
      throw redirect(`/sign-in?return-to=${encodeURIComponent(asked.pathname + asked.search)}`);
    }
    throw error;
  }
}
