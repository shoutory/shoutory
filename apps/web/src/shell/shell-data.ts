import { useRouteLoaderData } from "react-router";
import { z } from "zod";
import { ApiError, request } from "../http/client";

const organization = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  type: z.enum(["agency", "team", "personal"]),
  // The caller's own role in the organization (`owner`, `admin` or `member`).
  org_role: z.string(),
});
const workspace = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  slug: z.string(),
  // The caller's own role in the workspace.
  role: z.string(),
});

export type Organization = z.infer<typeof organization>;
export type Workspace = z.infer<typeof workspace>;

/** The shell's lists, or the failure that stopped them: a list that fails shows inline and the frame stays. */
export type ShellData = { organizations: Organization[]; workspaces: Workspace[] } | { error: ApiError };

/** An id that is none of my workspaces: only judged when the lists loaded and there is at least one workspace. */
export const isUnknownWorkspace = (data: ShellData, id: string | undefined): boolean =>
  !("error" in data) && data.workspaces.length > 0 && !data.workspaces.some((w) => w.id === id);

/** An id that is none of my organizations, or is a personal one (which has no clients or billing page). */
export const isUnknownOrganization = (data: ShellData, id: string | undefined): boolean =>
  !("error" in data) && !data.organizations.some((org) => org.id === id && org.type !== "personal");

/** The id of the shell route; the pages under it read its loader data. */
export const SHELL_ROUTE_ID = "shell";

// The first page only (AGENTS 6.6, R393): a `next_cursor` beyond it is not followed in M0.
const LIMIT = "?limit=100";

export async function shellLoader(): Promise<ShellData> {
  try {
    const [organizations, workspaces] = await Promise.all([
      request(z.array(organization), `/api/v1/organizations${LIMIT}`),
      request(z.array(workspace), `/api/v1/workspaces${LIMIT}`),
    ]);
    return { organizations, workspaces };
  } catch (error) {
    // An ended session is the guard's page, not an inline panel.
    if (error instanceof ApiError && error.state !== "session_expired") return { error };
    throw error;
  }
}

export const useShellData = (): ShellData => {
  const data = useRouteLoaderData<ShellData>(SHELL_ROUTE_ID);
  if (!data) throw new Error("the shell data is read outside the shell");
  return data;
};
