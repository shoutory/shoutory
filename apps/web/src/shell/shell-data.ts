import { useRouteLoaderData } from "react-router";
import { z } from "zod";
import { ApiError, request } from "../http/client";

const organization = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  type: z.enum(["agency", "team", "personal"]),
  org_role: z.string(),
});
const workspace = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.string(),
});

export type Organization = z.infer<typeof organization>;
export type Workspace = z.infer<typeof workspace>;

// A failed admin read is kept as the error, never taken as "not an admin".
export type ShellData =
  | { organizations: Organization[]; workspaces: Workspace[]; admin: boolean | ApiError }
  | { error: ApiError };

export const isUnknownWorkspace = (data: ShellData, id: string | undefined): boolean =>
  !("error" in data) && data.workspaces.length > 0 && !data.workspaces.some((w) => w.id === id);

export const isUnknownOrganization = (data: ShellData, id: string | undefined): boolean =>
  !("error" in data) && !data.organizations.some((org) => org.id === id && org.type !== "personal");

export const SHELL_ROUTE_ID = "shell";

// Only the first page is read; a `next_cursor` beyond it is not followed.
const LIMIT = "?limit=100";

const adminAnswer = z.object({ admin: z.boolean() });

// The admin read never fails the shell: the error is kept for the admin screens to show.
async function readAdmin(): Promise<boolean | ApiError> {
  try {
    return (await request(adminAnswer, "/api/v1/instance/admin")).admin;
  } catch (error) {
    if (error instanceof ApiError && error.state === "session_expired") throw error;
    if (error instanceof ApiError) return error;
    throw error;
  }
}

export async function shellLoader(): Promise<ShellData> {
  try {
    const [organizations, workspaces, admin] = await Promise.all([
      request(z.array(organization), `/api/v1/organizations${LIMIT}`),
      request(z.array(workspace), `/api/v1/workspaces${LIMIT}`),
      readAdmin(),
    ]);
    return { organizations, workspaces, admin };
  } catch (error) {
    if (error instanceof ApiError && error.state !== "session_expired") return { error };
    throw error;
  }
}

export const useShellData = (): ShellData => {
  const data = useRouteLoaderData<ShellData>(SHELL_ROUTE_ID);
  if (!data) throw new Error("the shell data is read outside the shell");
  return data;
};
