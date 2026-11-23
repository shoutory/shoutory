import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWED, functionBodies, lockOrderViolations } from "../../scripts/lock-order.mjs";

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const sources = readdirSync(migrations)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(join(migrations, file), "utf8"));

const define = (name, body) =>
  `CREATE FUNCTION app.${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} END $$;`;
// The one writer of the audit chain head, the only table of the last rank.
const AUDIT = define("audit_append", "UPDATE app.audit_heads SET head_hash = 'x' WHERE id = 1;");
const LOCK = (table, clause = "FOR UPDATE") => `PERFORM 1 FROM app.${table} AS t WHERE t.id = 1 ${clause};`;

test("every definer takes row locks in rank order", () => {
  assert.ok(functionBodies(sources).size >= 20, "fewer than 20 functions were read");
  assert.deepEqual(lockOrderViolations(sources), []);
});

// [case, function body, the files the body is read with, whether it is flagged]
const FIXTURES = [
  ["operations before channels", `${LOCK("operations")} ${LOCK("channels")}`, [], true],
  [
    "a channel share before an operations update",
    `${LOCK("channels", "FOR SHARE")} UPDATE app.operations AS o SET state = 'x' WHERE o.id = 1;`,
    [],
    false,
  ],
  [
    "an evidence insert, then the update of the operations row already locked",
    `${LOCK("operations", "FOR NO KEY UPDATE")} INSERT INTO app.operation_evidence (id) VALUES (1); UPDATE app.operations AS o SET state = 'x' WHERE o.id = 1;`,
    [],
    false,
  ],
  [
    "a plain read of operations, then a channel lock",
    `SELECT 1 FROM app.operations AS o WHERE o.id = 1; ${LOCK("channels")}`,
    [],
    false,
  ],
  [
    "the outbox, then the audit write",
    "INSERT INTO app.outbox (type) VALUES ('x'); PERFORM app.audit_append();",
    [AUDIT],
    false,
  ],
  [
    "the audit write, then an outbox update",
    "PERFORM app.audit_append(); UPDATE app.outbox AS o SET attempts = 1 WHERE o.id = 1;",
    [AUDIT],
    true,
  ],
  [
    "a plain insert of a lower rank after the audit write (a new row nobody can wait on)",
    "PERFORM app.audit_append(); INSERT INTO app.operation_evidence (id) VALUES (1);",
    [AUDIT],
    false,
  ],
  [
    "an insert with ON CONFLICT DO UPDATE of the keys table after the audit write",
    "PERFORM app.audit_append(); INSERT INTO app.idempotency_keys (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET state = 'x';",
    [AUDIT],
    true,
  ],
  [
    "a called helper that locks a channel after operations",
    `${LOCK("operations")} PERFORM app.take_channel();`,
    [define("take_channel", LOCK("channels"))],
    true,
  ],
];
// A trigger on operations that writes the post: its write counts for every function that updates operations, so a definer
// that ends an operation must have locked the post and the variant (rank 3) before the operation (rank 6) itself.
const ROLLUP = `CREATE FUNCTION app.rollup_fixture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
  BEGIN UPDATE app.posts AS p SET status = 'x' WHERE p.id = NEW.post_id; RETURN NULL; END $$;
  CREATE TRIGGER operations_c_rollup AFTER INSERT OR UPDATE ON app.operations
    FOR EACH ROW EXECUTE FUNCTION app.rollup_fixture();`;
const END_OPERATION = "UPDATE app.operations AS o SET state = 'published' WHERE o.id = 1;";
FIXTURES.push(
  ["an operations update with no pre-lock when a trigger writes the post", END_OPERATION, [ROLLUP], true],
  [
    "an operations update after the post and variant locks when a trigger writes the post",
    `${LOCK("posts")} ${LOCK("post_variants")} ${END_OPERATION}`,
    [ROLLUP],
    false,
  ],
);
for (const [title, body, files, flagged] of FIXTURES) {
  test(`the lock-order check ${flagged ? "flags" : "passes"} ${title}`, () => {
    const found = lockOrderViolations([...files, define("fixture", body)]);
    assert.equal(found.length > 0, flagged, found.join("; "));
  });
}

const AFTER_AUDIT = "PERFORM app.audit_append(); UPDATE app.idempotency_keys SET state = 'x' WHERE id = 1;";
test("the lock-order check permits idem_finish as the only rank-10-after-11 write", () => {
  assert.deepEqual(ALLOWED, ["idem_finish"]);
  assert.deepEqual(lockOrderViolations([AUDIT, define("idem_finish", AFTER_AUDIT)]), []);
  assert.equal(lockOrderViolations([AUDIT, define("idem_finish_again", AFTER_AUDIT)]).length, 1);
});
