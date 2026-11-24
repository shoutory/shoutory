import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { z } from "zod";

// Every setting is transaction-local, so a pooled connection never carries one request's tenant into the next.

const MAX_WORKSPACES = 500;
const MAX_JOB_PURPOSE = 64;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const ctxSchema = z
  .object({
    organizationId: uuid,
    workspaceIds: z.array(uuid).max(MAX_WORKSPACES),
    writeWorkspaceId: uuid,
    principalKind: z.enum(["user", "service", "job", "portal"]),
    serviceKind: z.enum(["api_key", "oauth_client", "agent_runner"]),
    principalId: uuid,
    portalGrantId: uuid,
    jobPurpose: z.string().min(1).max(MAX_JOB_PURPOSE),
  })
  .partial()
  .strict();

export type TenantCtx = Readonly<Omit<z.input<typeof ctxSchema>, "workspaceIds">> & {
  readonly workspaceIds?: readonly string[];
};

declare const tenantBrand: unique symbol;

/** The transaction a request runs in: it can query and nothing else, so it cannot end or reset the context. */
export interface TenantTx {
  readonly [tenantBrand]: true;
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

// An absent field is sent as an empty string: NULL would reset the setting instead of setting it.
function settingsOf(ctx: z.output<typeof ctxSchema>): [string[], string[]] {
  const ids = ctx.workspaceIds === undefined ? "" : `{${[...new Set(ctx.workspaceIds)].join(",")}}`;
  const entries: [string, string | undefined][] = [
    ["app.organization_id", ctx.organizationId],
    ["app.workspace_ids", ids],
    ["app.write_workspace_id", ctx.writeWorkspaceId],
    ["app.principal_kind", ctx.principalKind],
    ["app.service_kind", ctx.serviceKind],
    ["app.principal_id", ctx.principalId],
    ["app.portal_grant_id", ctx.portalGrantId],
    ["app.job_purpose", ctx.jobPurpose],
  ];
  return [entries.map(([name]) => name), entries.map(([, value]) => value ?? "")];
}

// A rollback that fails leaves the connection in doubt: the error is returned so the pool destroys it.
async function rollback(client: PoolClient): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export async function withTenant<T>(
  pool: Pool,
  ctx: TenantCtx,
  run: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const [names, values] = settingsOf(ctxSchema.parse(ctx));
  const client = await pool.connect();
  let destroy: Error | undefined;
  // A connection lost mid-request is reported by the failing query; this only marks the client for destruction so
  // the pool never reuses it and the event is not left without a listener.
  const onConnectionError = (error: Error) => {
    destroy = error;
  };
  client.on("error", onConnectionError);
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config(s.name, s.value, true) FROM unnest($1::text[], $2::text[]) AS s(name, value)",
      [names, values],
    );
    const result = await run({
      query: (text: string, values?: unknown[]) => client.query(text, values),
    } as TenantTx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    destroy = (await rollback(client)) ?? destroy;
    throw error;
  } finally {
    client.off("error", onConnectionError);
    client.release(destroy);
  }
}
