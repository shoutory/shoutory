import { type LoaderFunctionArgs, replace } from "react-router";
import { z } from "zod";
import { ApiError, request } from "../http/client";
import { forgetWorkspace } from "../shell/last-workspace";

const sessionSchema = z.object({
  session: z.object({ id: z.string(), expiresAt: z.string() }),
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), emailVerified: z.boolean() }),
});

export type Session = z.infer<typeof sessionSchema>;

export const readSession = () => request(sessionSchema, "/api/auth/get-session");

export const SESSION_ROUTE_ID = "session";

export async function sessionGuard({ request: navigation }: LoaderFunctionArgs) {
  try {
    return await readSession();
  } catch (error) {
    if (error instanceof ApiError && error.state === "session_expired") {
      // The next person on this browser must not inherit the last workspace.
      forgetWorkspace();
      const asked = new URL(navigation.url);
      throw replace(`/sign-in?return-to=${encodeURIComponent(asked.pathname + asked.search)}`);
    }
    throw error;
  }
}
