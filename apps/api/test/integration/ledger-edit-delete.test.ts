import { transition } from "@shoutory/core/ledger/client";
import type { ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { describe, expect, it } from "vitest";
import { inJob, sqlOf } from "../../src/jobs/ledger/held.js";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { createLogger } from "../../src/logging/logger.js";
import { leaks } from "../support/canary.js";
import {
  admin,
  called,
  type Env,
  holdFirst,
  makeEnv,
  newWorkspace,
  opOf,
  plant,
  recover,
  rows,
  sleep,
  takeBack,
  useDispatchEnv,
  workerPool,
} from "../support/ledger-dispatch-env.js";

useDispatchEnv();

type Kind = "edit" | "delete";
const isAction = (_url: string, method: string) => method === "PATCH" || method === "DELETE";

// The routes a test counts, so a call sent twice is seen.
function counter() {
  const seen: Record<string, number> = {};
  return {
    seen,
    before: (route: string) => {
      seen[route] = (seen[route] ?? 0) + 1;
    },
  };
}

async function remote(e: Env, text = "original text"): Promise<string> {
  const made = await fetch(`${e.sim.url}/v1/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return ((await made.json()) as { id: string }).id;
}

const evidenceOf = (id: string) =>
  rows("SELECT kind, level, outcome_kind, external_id FROM app.operation_evidence WHERE operation_id = $1", [
    id,
  ]);

describe("an edit operation of a settled variant (floor)", () => {
  it("is claimed, calls adapter edit once with the frozen text and publishes with edit_applied; the simulator holds one status", async () => {
    const calls = counter();
    const e = await makeEnv({ before: calls.before });
    try {
      const externalId = await remote(e);
      const id = await plant(e, { action: { kind: "edit", externalId } });
      expect(await e.turn()).toMatchObject({ kind: "dispatched", id, to: "published" });
      expect(await opOf(id)).toMatchObject({ state: "published", effect: "confirmed" });
      expect(calls.seen["PATCH /v1/posts/:id"]).toBe(1);
      expect(e.sim.stored()).toEqual([{ externalId, text: "hello dispatch" }]);
      expect(await evidenceOf(id)).toEqual([
        { kind: "edit_applied", level: "receipt", outcome_kind: null, external_id: externalId },
      ]);
    } finally {
      await e.close();
    }
  }, 30_000);
});

const gone = { kind: "respond", status: 500, afterEffect: true } as const;
const lost = { kind: "respond", status: 500 } as const;
const NEVER = { retrySafety: { ...fixtureManifest.retrySafety, delete: "never" } };
const withContent = (e: Env) => {
  const base: ProviderAdapter = e.adapters[e.providerId] as ProviderAdapter;
  e.adapters[e.providerId] = {
    ...base,
    readSource: async (context, post) => {
      const result = await base.readBack(context, post);
      const stored = e.sim.stored().find((one) => one.externalId === post.externalId);
      return stored === undefined || !result.ok
        ? result
        : { ...result, content: { text: stored.text, settings: {} } };
    },
  };
};
// [case, kind, the manifest, the fault, the state it ends in, what its evidence says, calls of the action route]
const UNKNOWN: [
  string,
  Kind,
  Record<string, unknown>,
  typeof gone | typeof lost,
  string,
  string | undefined,
  number,
][] = [
  ["a delete the manifest marks idempotent is sent again", "delete", {}, gone, "published", "removed", 2],
  [
    "a delete that is not idempotent is read back by id and a 404 is removed",
    "delete",
    NEVER,
    gone,
    "published",
    "removed",
    1,
  ],
  [
    "a delete still present after the read goes to a person",
    "delete",
    NEVER,
    lost,
    "needs_human",
    undefined,
    1,
  ],
  [
    "an edit whose text and content warning match is applied",
    "edit",
    {},
    gone,
    "published",
    "edit_applied",
    1,
  ],
  [
    "an edit that differs from the frozen text goes to a person",
    "edit",
    {},
    lost,
    "needs_human",
    undefined,
    1,
  ],
];
describe("an unknown edit or delete outcome follows the manifest (floor)", () => {
  it.each(UNKNOWN)(
    "%s, and is never sent blind",
    async (_name, kind, manifest, fault, ends, evidence, sent) => {
      const calls = counter();
      const e = await makeEnv({ before: calls.before, manifest });
      try {
        withContent(e);
        const externalId = await remote(e);
        const id = await plant(e, { action: { kind, externalId } });
        e.sim.arm(kind, fault);
        await e.turn();
        expect(await opOf(id)).toMatchObject({ state: "unknown_external_state" });
        await recover(e, id);
        expect(await opOf(id)).toMatchObject({ state: ends });
        const route = kind === "edit" ? "PATCH /v1/posts/:id" : "DELETE /v1/posts/:id";
        expect(calls.seen[route]).toBe(sent);
        const kinds = (await evidenceOf(id)).map((row) => row.kind);
        if (evidence === undefined) expect(kinds).not.toContain("edit_applied");
        else expect(kinds).toContain(evidence);
      } finally {
        await e.close();
      }
    },
    60_000,
  );
});

describe("what an edit or a delete needs to be sent", () => {
  it("a delete is sent although its operation holds no frozen version", async () => {
    const e = await makeEnv();
    try {
      const externalId = await remote(e);
      const id = await plant(e, { action: { kind: "delete", externalId }, unfrozen: true });
      expect(await e.turn()).toMatchObject({ kind: "dispatched", id, to: "published" });
      expect(e.sim.stored()).toEqual([]);
    } finally {
      await e.close();
    }
  }, 30_000);

  it("an applied edit is applied, not sent to a person, when the source holds a setting the frozen version leaves unset", async () => {
    const e = await makeEnv();
    try {
      withContent(e);
      const base = e.adapters[e.providerId] as ProviderAdapter;
      const read = base.readSource;
      e.adapters[e.providerId] = {
        ...base,
        readSource: async (context, post) => {
          const answer = await read?.(context, post);
          return answer?.ok && answer.content
            ? { ...answer, content: { ...answer.content, settings: { spoiler_text: "" } } }
            : (answer ?? { ok: false, effect: "none", errorClass: "permanent" });
        },
        settingsWithDefaults: (settings) => ({ spoiler_text: "", ...settings }),
      };
      const externalId = await remote(e);
      const id = await plant(e, { action: { kind: "edit", externalId } });
      e.sim.arm("edit", gone);
      await e.turn();
      await recover(e, id);
      expect(await opOf(id)).toMatchObject({ state: "published" });
    } finally {
      await e.close();
    }
  }, 60_000);
});

const NO_READ = {
  readBackMode: "E",
  idempotency: { ...fixtureManifest.idempotency, resendAfterUnknown: "read_back_only" },
  retrySafety: { prepare: "safe", commit: "never", readBack: "safe", edit: "never", delete: "never" },
};
describe("an unknown outcome on a manifest with no read-back for the kind (floor)", () => {
  it.each(["edit", "delete"] as const)(
    "%s goes to needs_human and sends nothing again",
    async (kind) => {
      const calls = counter();
      const e = await makeEnv({ before: calls.before, manifest: NO_READ });
      try {
        const externalId = await remote(e);
        const id = await plant(e, { action: { kind, externalId } });
        e.sim.arm(kind, gone);
        await e.turn();
        expect(await opOf(id)).toMatchObject({ state: "unknown_external_state" });
        await recover(e, id);
        expect(await opOf(id)).toMatchObject({ state: "needs_human" });
        const route = kind === "edit" ? "PATCH /v1/posts/:id" : "DELETE /v1/posts/:id";
        expect(calls.seen[route]).toBe(1);
      } finally {
        await e.close();
      }
    },
    60_000,
  );
});

const LOST: [string, (id: string, e: Env) => Promise<void>][] = [
  [
    "the token moves on",
    (id) =>
      admin(async (client) => {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.job_purpose', 'claim_polls', true)");
        await client.query("UPDATE app.operations SET fencing_token = fencing_token + 1 WHERE id = $1", [id]);
        await client.query("COMMIT");
      }),
  ],
  ["the lease ends and the sweep takes the row", (id, e) => takeBack(id, e.sweepNow)],
];
describe("a lease lost during an edit or a delete (floor)", () => {
  it.each(
    LOST.flatMap(([name, lose]) => (["edit", "delete"] as const).map((kind) => [kind, name, lose] as const)),
  )(
    "%s: changes nothing and sends nothing when %s",
    async (kind, _name, lose) => {
      const hold = holdFirst(isAction);
      const e = await makeEnv({ hold, lease: 24 });
      try {
        const externalId = await remote(e);
        const id = await plant(e, { action: { kind, externalId } });
        const running = e.turn();
        await called(hold);
        await lose(id, e);
        const before = await opOf(id);
        expect(await running).toMatchObject({ kind: "lost" });
        await sleep(600);
        expect({ ...(await opOf(id)), horizon_in: 0 }).toEqual({ ...before, horizon_in: 0 });
        expect(e.sim.stored()).toEqual([{ externalId, text: "original text" }]);
      } finally {
        hold.release();
        await e.close();
      }
    },
    60_000,
  );
});

const post = { source: "adapter" };
const EVIDENCE = {
  post: { kind: "accepted", level: "receipt", outcome_kind: "post" },
  applied: { kind: "edit_applied", level: "receipt", outcome_kind: null },
  removed: { kind: "removed", level: "receipt", outcome_kind: null },
};
// [kind of the operation, evidence it is given, does it move]
const PROOF: [string, "publish" | Kind, keyof typeof EVIDENCE, boolean][] = [
  ["a post that exists never moves an edit", "edit", "post", false],
  ["a post that exists never moves a delete", "delete", "post", false],
  ["a removal never moves an edit", "edit", "removed", false],
  ["an edit never moves a publish", "publish", "applied", false],
  ["an edit is moved by edit_applied", "edit", "applied", true],
  ["a delete is moved by removed", "delete", "removed", true],
];
const settled = (kind: Kind) => ({ action: { kind, externalId: "remote-1" } });
async function dispatching(e: Env, kind: "publish" | Kind): Promise<{ id: string; ws: string }> {
  const id = await plant(e, {
    state: "dispatching",
    effect: "possible",
    ...(kind === "publish" ? {} : settled(kind)),
  });
  return { id, ws: await workspaceOf(id) };
}

describe("record_evidence moves an edit or a delete only by its own evidence (floor)", () => {
  it.each(PROOF)("%s", async (_name, kind, given, moves) => {
    const e = await makeEnv();
    try {
      const { id, ws } = await dispatching(e, kind);
      const { kind: evidenceKind, level, outcome_kind: outcome } = EVIDENCE[given];
      const refs = JSON.stringify({ ...post, external_id: "remote-1" });
      const [one] = await inJob(
        workerPool(),
        ws,
        async (tx) =>
          (
            await tx.query("SELECT moved FROM app.record_evidence($1, $2, $3, $4, $5, $6::jsonb)", [
              ws,
              id,
              evidenceKind,
              level,
              outcome,
              refs,
            ])
          ).rows,
      );
      expect(one?.moved).toBe(moves);
      expect((await opOf(id)).state).toBe(moves ? "published" : "dispatching");
    } finally {
      await e.close();
    }
  });
});

describe("operation_transition refuses evidence that is not the kind's own (floor)", () => {
  it.each(PROOF.filter(([, , , moves]) => !moves))("%s", async (_name, kind, given) => {
    const e = await makeEnv();
    try {
      const { id, ws } = await dispatching(e, kind);
      const evidence = { ...EVIDENCE[given], refs: { ...post, external_id: "remote-1" } };
      const move = (tx: Parameters<typeof sqlOf>[0]) =>
        transition(sqlOf(tx), {
          workspaceId: ws,
          operationId: id,
          token: 1,
          from: "dispatching",
          to: "published",
          actor: "W",
          changes: { evidence },
        });
      await expect(inJob(workerPool(), ws, move)).rejects.toMatchObject({ code: "22023" });
      expect((await opOf(id)).state).toBe("dispatching");
    } finally {
      await e.close();
    }
  });
});

async function workspaceOf(id: string): Promise<string> {
  return String((await rows("SELECT workspace_id FROM app.operations WHERE id = $1", [id]))[0]?.workspace_id);
}

describe("the replaced definers keep tenants apart (floor)", () => {
  it.each(["edit", "delete"] as const)("refuse a foreign workspace's %s operation", async (kind) => {
    const e = await makeEnv();
    try {
      const foreign = await newWorkspace();
      const id = await plant(e, {
        state: "dispatching",
        effect: "possible",
        workspace: foreign,
        action: { kind, externalId: "remote-1" },
      });
      const mine = await workspaceOf(await plant(e, { state: "dispatching", effect: "possible" }));
      const evidence = EVIDENCE[kind === "edit" ? "applied" : "removed"];
      await expect(
        inJob(workerPool(), mine, (tx) =>
          tx.query("SELECT * FROM app.record_evidence($1, $2, $3, $4, $5, $6::jsonb)", [
            foreign,
            id,
            evidence.kind,
            evidence.level,
            evidence.outcome_kind,
            JSON.stringify(post),
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        inJob(workerPool(), mine, (tx) =>
          transition(sqlOf(tx), {
            workspaceId: foreign,
            operationId: id,
            token: 1,
            from: "dispatching",
            to: "published",
            actor: "W",
            changes: { evidence: { ...evidence, refs: post } },
          }),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect((await opOf(id)).state).toBe("dispatching");
    } finally {
      await e.close();
    }
  });
});

const TOKEN = "ledger-edit-token-canary-1";
describe("no token reaches a log or a stored row on an edit or a delete (floor)", () => {
  it.each([
    ["edit", undefined],
    ["delete", undefined],
    ["edit", 500],
    ["delete", 500],
  ] as const)(
    "%s answered %s: the token is in none of them, in any encoding",
    async (kind, status) => {
      const calls = counter();
      const e = await makeEnv({ before: calls.before });
      const lines: string[] = [];
      const own = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
      try {
        const externalId = await remote(e);
        const id = await plant(e, { token: TOKEN, action: { kind, externalId } });
        if (status !== undefined) e.sim.arm(kind, { kind: "respond", status });
        const result = await runTurn({
          pool: workerPool(),
          logger: own,
          registry: e.registry,
          adapters: e.adapters,
          fetchFor: e.fetchFor,
          credentials: e.credentials,
          queue: e.queueName,
          owner: "owner-w",
          closing: new AbortController().signal,
        });
        const stored = await rows(
          `SELECT row_to_json(a)::text AS t FROM app.operation_attempts a WHERE operation_id = $1
         UNION ALL SELECT row_to_json(x)::text FROM app.outbox x WHERE x.payload ->> 'operation_id' = $1::text
         UNION ALL SELECT row_to_json(v)::text FROM app.operation_evidence v WHERE v.operation_id = $1
         UNION ALL SELECT row_to_json(o)::text FROM app.operations o WHERE o.id = $1`,
          [id],
        );
        const route = kind === "edit" ? "PATCH /v1/posts/:id" : "DELETE /v1/posts/:id";
        expect(calls.seen[route]).toBe(1);
        const haystack = [JSON.stringify(result), ...lines, ...stored.map((row) => String(row.t))];
        expect(leaks(haystack.join("\n"), [TOKEN])).toEqual([]);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});
