import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withAdvisoryLock } from "../../src/locks.js";
import {
  type AcceptedRevision,
  type MigrateLimits,
  MigrationChecksumError,
  MigrationLintError,
  migrateDatabase,
} from "../../src/migrate/runner.js";
import { emptyDatabase, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();
const CREATE_WIDGETS = "CREATE TABLE public.widgets (id int);";

function sandbox() {
  let db: TestDatabase;
  let dir: string;
  beforeEach(async () => {
    db = await emptyDatabase(env);
    dir = await mkdtemp(join(tmpdir(), "migrations-"));
  });
  afterEach(async () => {
    await db.drop();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    write: (name: string, sql: string) => writeFile(join(dir, name), sql),
    migrate: (limits?: MigrateLimits, accepted?: AcceptedRevision[]) =>
      migrateDatabase(db.url("owner"), dir, limits, accepted),
    query: (sql: string) => db.pool("owner").query(sql),
    db: () => db,
    recorded: async () =>
      (await db.pool("owner").query("SELECT name FROM app.schema_migrations ORDER BY name")).rows.map(
        (row) => row.name as string,
      ),
  };
}

describe("migration runner: history", () => {
  const box = sandbox();

  it("applies pending files in order and records each once", async () => {
    await box.write("0001_widgets.sql", CREATE_WIDGETS);
    await box.write("0002_widget_row.sql", "INSERT INTO public.widgets VALUES (1);");
    expect(await box.migrate()).toEqual(["0001_widgets.sql", "0002_widget_row.sql"]);
    expect(await box.migrate()).toEqual([]);
    expect(await box.recorded()).toEqual(["0001_widgets.sql", "0002_widget_row.sql"]);
  });

  it("refuses an applied file whose checksum changed", async () => {
    await box.write("0001_widgets.sql", CREATE_WIDGETS);
    await box.migrate();
    await box.write("0001_widgets.sql", "CREATE TABLE public.widgets (id int, extra int);");
    await box.write("0002_more.sql", "SELECT 1;");
    await expect(box.migrate()).rejects.toThrow(MigrationChecksumError);
    expect(await box.recorded()).toEqual(["0001_widgets.sql"]);
  });

  it("refuses a pending file with an unsafe statement before applying any file", async () => {
    await box.write("0001_widgets.sql", CREATE_WIDGETS);
    await box.write("0002_widget_index.sql", "CREATE INDEX widgets_id_idx ON public.widgets (id);");
    await expect(box.migrate()).rejects.toThrow(MigrationLintError);
    expect((await box.query("SELECT to_regclass('public.widgets') AS found")).rows).toEqual([
      { found: null },
    ]);
  });

  it("applies each file once when two runners start together", async () => {
    // The file is not idempotent and slow, so a second concurrent apply would fail on the table or the record.
    await box.write("0001_widgets.sql", `SELECT pg_sleep(0.5); ${CREATE_WIDGETS}`);
    const applied = await Promise.all([box.migrate(), box.migrate()]);
    expect(applied.flat()).toEqual(["0001_widgets.sql"]);
    expect(await box.recorded()).toEqual(["0001_widgets.sql"]);
  });
});

// The table has rows and forced row security with no policy, so the owner who runs a file sees none of them.
const FORCED_WIDGETS = `
  CREATE TABLE public.widgets (id int, label text);
  CREATE TABLE public.results (step text, changed int);
  INSERT INTO public.widgets VALUES (1, 'old'), (2, 'old'), (3, 'old');
  ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.widgets FORCE ROW LEVEL SECURITY;`;
const BACKFILL = (step: string, policy: boolean) => `
  DO $$
  DECLARE changed integer;
  BEGIN
    ${policy ? "CREATE POLICY backfill_probe ON public.widgets FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);" : ""}
    UPDATE public.widgets SET label = 'new';
    GET DIAGNOSTICS changed = ROW_COUNT;
    INSERT INTO public.results VALUES ('${step}', changed);
    ${policy ? "DROP POLICY backfill_probe ON public.widgets;" : ""}
  END
  $$;`;

describe("migration runner: backfill under forced row security", () => {
  const box = sandbox();

  it("a backfill under FORCE RLS as the owner updates the expected count, 0 without its temporary policy, and none remains", async () => {
    await box.write("0001_widgets.sql", FORCED_WIDGETS);
    await box.write("0002_blind.sql", BACKFILL("blind", false));
    await box.write("0003_seen.sql", BACKFILL("seen", true));
    await box.migrate();
    const results = await box.query("SELECT step, changed FROM public.results ORDER BY step");
    expect(results.rows).toEqual([
      { step: "blind", changed: 0 },
      { step: "seen", changed: 3 },
    ]);
    expect(
      (await box.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'widgets'")).rows,
    ).toEqual([{ n: 0 }]);
  });
});

describe("migration runner: accepted revisions", () => {
  const box = sandbox();
  const sum = (text: string) => createHash("sha256").update(text).digest("hex");
  const V1 = "-- first wording\nCREATE TABLE public.widgets (id int);";
  const V2 = "-- second wording\nCREATE TABLE public.widgets (id int);";
  const NAME = "0001_widgets.sql";
  const stored = async () =>
    (await box.query("SELECT checksum FROM app.schema_migrations")).rows.map((row) => row.checksum);

  it("passes and replaces the stored checksum when the pair of sums is listed", async () => {
    await box.write(NAME, V1);
    await box.migrate();
    await box.write(NAME, V2);
    expect(await box.migrate(undefined, [{ name: NAME, from: sum(V1), to: sum(V2) }])).toEqual([]);
    expect(await stored()).toEqual([sum(V2)]);
  });

  it.each([V1, V2])("passes from either of two earlier sums when both are listed", async (start) => {
    const V3 = "-- third wording\nCREATE TABLE public.widgets (id int);";
    await box.write(NAME, start);
    await box.migrate();
    await box.write(NAME, V3);
    const listed = [V1, V2].map((from) => ({ name: NAME, from: sum(from), to: sum(V3) }));
    expect(await box.migrate(undefined, listed)).toEqual([]);
    expect(await stored()).toEqual([sum(V3)]);
  });

  it("is refused when the file no longer holds the listed new sum", async () => {
    await box.write(NAME, V1);
    await box.migrate();
    await box.write(NAME, `${V2}\nALTER TABLE public.widgets ADD COLUMN extra int;`);
    const listed = [{ name: NAME, from: sum(V1), to: sum(V2) }];
    await expect(box.migrate(undefined, listed)).rejects.toThrow(MigrationChecksumError);
    expect(await stored()).toEqual([sum(V1)]);
  });

  it("is refused when the stored sum is not the listed old sum", async () => {
    await box.write(NAME, V1);
    await box.migrate();
    await box.write(NAME, V2);
    const listed = [{ name: NAME, from: sum("another history"), to: sum(V2) }];
    await expect(box.migrate(undefined, listed)).rejects.toThrow(MigrationChecksumError);
    expect(await stored()).toEqual([sum(V1)]);
  });
});

describe("migration runner: transaction modes", () => {
  const box = sandbox();
  const INDEX = "CREATE INDEX CONCURRENTLY IF NOT EXISTS widgets_id_idx ON public.widgets (id);";

  it("runs a marked file outside a transaction so an index can be built concurrently", async () => {
    await box.write("0001_widgets.sql", CREATE_WIDGETS);
    await box.write("0002_widget_index.sql", `-- shoutory:no-transaction\n${INDEX}`);
    expect(await box.migrate()).toEqual(["0001_widgets.sql", "0002_widget_index.sql"]);
    const index = await box.query(
      "SELECT indisvalid FROM pg_index WHERE indexrelid = 'public.widgets_id_idx'::regclass",
    );
    expect(index.rows).toEqual([{ indisvalid: true }]);
  });

  it("runs an unmarked file in one transaction that rolls back whole on error", async () => {
    await box.write("0001_half.sql", "CREATE TABLE public.half (id int); SELECT 1 / 0;");
    await expect(box.migrate()).rejects.toThrow("division by zero");
    expect((await box.query("SELECT to_regclass('public.half') AS found")).rows).toEqual([{ found: null }]);
    expect(await box.recorded()).toEqual([]);
  });

  // A failed concurrent build leaves an invalid index; "IF NOT EXISTS" then skips it on the rerun, so the file
  // would be recorded as applied while the index is unusable.
  it("refuses to record a marked file while an invalid index exists", async () => {
    await box.write("0001_dups.sql", "CREATE TABLE public.dups AS SELECT 1 AS id UNION ALL SELECT 1;");
    await box.write(
      "0002_dups_key.sql",
      "-- shoutory:no-transaction\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS dups_id_key ON public.dups (id);",
    );
    await expect(box.migrate()).rejects.toThrow("could not create unique index");
    await box.query("DELETE FROM public.dups WHERE ctid = (SELECT max(ctid) FROM public.dups)");
    await expect(box.migrate()).rejects.toMatchObject({ name: "MigrationInvalidIndexError" });
    expect(await box.recorded()).toEqual(["0001_dups.sql"]);
  });
});

describe("migration runner: folder", () => {
  const box = sandbox();

  it.each([
    ["a file whose name misses the pattern", ["0001_ok.sql", "0002-dash.sql"]],
    ["an upper-case name", ["0001_ok.sql", "0002_Upper.sql"]],
    ["two files with one number", ["0001_ok.sql", "0002_a.sql", "0002_b.sql"]],
    ["a gap in the sequence", ["0001_ok.sql", "0003_gap.sql"]],
    ["a sequence that does not start at 0001", ["0002_late.sql"]],
  ])("refuses %s before anything runs", async (_title, names) => {
    for (const name of names) await box.write(name, "SELECT 1;");
    await expect(box.migrate()).rejects.toMatchObject({ name: "MigrationFolderError" });
    const bootstrapped = await box.query("SELECT to_regclass('app.schema_migrations') AS found");
    expect(bootstrapped.rows).toEqual([{ found: null }]);
  });

  it("refuses a pending file numbered below the highest applied one", async () => {
    await box.write("0001_one.sql", "SELECT 1;");
    await box.write("0002_two.sql", "SELECT 2;");
    await box.migrate();
    await box.query("DELETE FROM app.schema_migrations WHERE name = '0001_one.sql'");
    await expect(box.migrate()).rejects.toMatchObject({ name: "MigrationFolderError" });
    expect(await box.recorded()).toEqual(["0002_two.sql"]);
  });
});

describe("migration runner: timeouts", () => {
  const box = sandbox();

  it("fails with a named error when a file waits too long for a table lock, and records nothing", async () => {
    await box.write("0001_widgets.sql", CREATE_WIDGETS);
    await box.migrate();
    await box.write("0002_note.sql", "ALTER TABLE public.widgets ADD COLUMN note text;");
    const holder = new Client({ connectionString: box.db().url("owner") });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE public.widgets IN ACCESS EXCLUSIVE MODE");
      await expect(box.migrate({ fileLockTimeoutMs: 300 })).rejects.toMatchObject({
        name: "MigrationLockTimeoutError",
      });
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect(await box.recorded()).toEqual(["0001_widgets.sql"]);
  });

  it("fails with a named error when another runner holds the migrate lock too long", async () => {
    await box.write("0001_widgets.sql", CREATE_WIDGETS);
    let release = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withAdvisoryLock(box.db().pool("owner"), "migrate", () => hold);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(box.migrate({ lockWaitMs: 300 })).rejects.toMatchObject({
        name: "MigrationLockTimeoutError",
      });
    } finally {
      release();
      await holding;
    }
    expect((await box.query("SELECT to_regclass('public.widgets') AS found")).rows).toEqual([
      { found: null },
    ]);
  });
});
