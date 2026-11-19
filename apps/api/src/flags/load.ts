import type { FlagState } from "@shoutory/core/flags";
import type { TenantTx } from "@shoutory/db/context";

// The one place the flag tables are read: the definer `flags_read` answers every flag with the overrides the
// caller's scope may see, and this loader turns those rows into the snapshot `flags.isOn` resolves over. It maps the
// instance overrides only: no caller has an organization or workspace scope to resolve yet.

interface LoadedFlag {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  /** The removal date, `YYYY-MM-DD`. */
  readonly removeBy: string;
  readonly defaultOn: boolean;
  /** The instance override, or null when none is set. */
  readonly instanceOverride: boolean | null;
}

export interface LoadedFlags {
  readonly flags: readonly LoadedFlag[];
  readonly snapshot: ReadonlyMap<string, FlagState>;
}

interface Row {
  readonly flag_key: string;
  readonly description: string;
  readonly owner: string;
  readonly remove_by: string;
  readonly default_on: boolean;
  readonly override_on: boolean | null;
}

const READ = `
  SELECT flag_key, description, owner, to_char(remove_by, 'YYYY-MM-DD') AS remove_by, default_on, override_on
  FROM app.flags_read()
  WHERE scope IS NULL OR scope = 'instance'`;

/** Every flag with its instance override, as a list and as a snapshot for `flags.isOn`. */
export async function loadFlags(tx: TenantTx): Promise<LoadedFlags> {
  const rows = (await tx.query<Row>(READ)).rows;
  const flags = rows.map((row) => ({
    key: row.flag_key,
    description: row.description,
    owner: row.owner,
    removeBy: row.remove_by,
    defaultOn: row.default_on,
    instanceOverride: row.override_on,
  }));
  const snapshot = new Map<string, FlagState>(
    rows.map((row) => [
      row.flag_key,
      {
        defaultOn: row.default_on,
        ...(row.override_on === null ? {} : { instance: row.override_on }),
        organizations: new Map(),
        workspaces: new Map(),
      },
    ]),
  );
  return { flags, snapshot };
}
