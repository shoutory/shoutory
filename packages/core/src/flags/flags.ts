// The most specific scope wins: workspace, organization, instance, then the flag's default.
export interface FlagState {
  readonly defaultOn: boolean;
  readonly instance?: boolean;
  readonly organizations: ReadonlyMap<string, boolean>;
  readonly workspaces: ReadonlyMap<string, boolean>;
}

export interface FlagContext {
  readonly snapshot: ReadonlyMap<string, FlagState>;
  readonly organizationId?: string;
  readonly workspaceId?: string;
}

function resolve(state: FlagState, organizationId?: string, workspaceId?: string): boolean {
  const workspace = workspaceId === undefined ? undefined : state.workspaces.get(workspaceId);
  if (workspace !== undefined) return workspace;
  const organization = organizationId === undefined ? undefined : state.organizations.get(organizationId);
  if (organization !== undefined) return organization;
  return state.instance ?? state.defaultOn;
}

export const flags = {
  // A key missing from the snapshot is a programming error, never "off".
  isOn(ctx: FlagContext, key: string): boolean {
    const state = ctx.snapshot.get(key);
    if (!state) throw new Error(`unknown feature flag: ${key}`);
    return resolve(state, ctx.organizationId, ctx.workspaceId);
  },
};
