import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, digestOf, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();
let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

const job = (workspaces: string[]): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: workspaces,
});
const poller: TenantCtx = { principalKind: "job", jobPurpose: "connect_challenge_poll" };
// Provider ids of the tests only: the database holds any provider id and names none.
const PROVIDER = "fixture_connect";
const OTHER_PROVIDER = "fixture_other";
const sealedColumns = () => [
  1,
  "k1",
  randomBytes(12),
  randomBytes(48),
  randomBytes(16),
  randomBytes(12),
  randomBytes(16),
  randomBytes(48),
];
const bot = (name: string) => digestOf(`bot-${name}-${randomUUID()}`);

async function commit(pool: "app" | "worker", ctx: TenantCtx, sql: string, params: unknown[]) {
  const client = await openTx(db.pool(pool), ctx);
  try {
    const result = (await client.query(sql, params)).rows;
    await client.query("COMMIT");
    return result;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const PUT =
  "SELECT app.connect_challenge_put($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) AS id";
const put = (user: string, ws: string, word: string, botDigest: Buffer, provider = PROVIDER) =>
  commit("app", asUser(user), PUT, [
    randomUUID(),
    ws,
    provider,
    digestOf(word),
    botDigest,
    null,
    ...sealedColumns(),
  ]);
const putError = (user: string, ws: string, word: string, botDigest: Buffer) =>
  put(user, ws, word, botDigest).then(
    () => undefined,
    (error: unknown) => error,
  );
const match = async (botDigest: Buffer, word: string | null, offset: number) =>
  (
    await commit("worker", poller, "SELECT app.connect_challenge_match($1, $2, $3, $4, $5) AS id", [
      botDigest,
      word === null ? null : digestOf(word),
      "-1001",
      "Team chat",
      offset,
    ])
  )[0]?.id ?? null;
const take = async (ws: string, provider: string, id: unknown, word: string) =>
  commit(
    "worker",
    job([ws]),
    "SELECT id, matched_chat_id, matched_title FROM app.connect_challenge_take($1, $2, $3, $4)",
    [ws, provider, id, digestOf(word)],
  );
const status = async (user: string, ws: string, id: unknown, provider = PROVIDER) =>
  (
    await commit("app", asUser(user), "SELECT * FROM app.connect_challenge_status($1, $2, $3)", [
      ws,
      provider,
      id,
    ])
  )[0];
const HOLD = "SELECT app.connect_challenge_hold($1, $2, $3, $4, $5) AS id";
const hold = (ws: string, botDigest: Buffer, word: string, reason: string, ctx: TenantCtx = poller) =>
  commit("worker", ctx, HOLD, [ws, PROVIDER, botDigest, digestOf(word), reason]);
const reasonOf = async (id: unknown) =>
  (
    await rows("SELECT wait_reason, matched_chat_id, consumed_at FROM app.connect_challenges WHERE id = $1", [
      id,
    ])
  )[0];
const offsetOf = async (botDigest: Buffer) =>
  (await rows("SELECT update_offset::text AS n FROM app.bot_claims WHERE bot_digest = $1", [botDigest]))[0]
    ?.n;

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin((client) => seedMembers(client));
});
afterAll(() => db.drop());

describe("the bot claim of a connect challenge (floor)", () => {
  it("one claim per bot digest: another workspace is refused with the generic answer, the same workspace may add a second chat", async () => {
    const mine = bot("claim");
    await put(U.admin, WA, `first-${randomUUID()}`, mine);
    await rows("UPDATE app.connect_challenges SET consumed_at = now() WHERE bot_digest = $1", [mine]);
    expect(await putError(U.admin, WA, `second-${randomUUID()}`, mine)).toBeUndefined();
    const refused = await putError(U.bOwner, WB, `other-${randomUUID()}`, mine);
    expect(refused).toMatchObject({ code: "SH409", message: expect.not.stringContaining("workspace") });
    expect(await rows("SELECT workspace_id FROM app.bot_claims WHERE bot_digest = $1", [mine])).toEqual([
      { workspace_id: WA },
    ]);
  });

  it("only an Admin of the workspace can put a challenge (42501)", async () => {
    const outcome = await attempt(db.pool("app"), asUser(U.editor), PUT, [
      randomUUID(),
      WA,
      PROVIDER,
      digestOf(`editor-${randomUUID()}`),
      bot("editor"),
      null,
      ...sealedColumns(),
    ]);
    expect(outcome.error).toMatchObject({ code: "42501" });
  });

  it("two open challenges of one bot cannot coexist; two bots keep separate offsets", async () => {
    const [one, two] = [bot("one"), bot("two")];
    const [older, newer] = [`older-${randomUUID()}`, `newer-${randomUUID()}`];
    await put(U.admin, WA, older, one);
    await put(U.admin, WA, newer, one);
    await put(U.admin, WA, `bot-two-${randomUUID()}`, two);
    expect(
      await rows(
        "SELECT count(*)::int AS n FROM app.connect_challenges WHERE bot_digest = $1 AND consumed_at IS NULL",
        [one],
      ),
    ).toEqual([{ n: 1 }]);
    expect(await match(one, older, 11)).toBeNull();
    expect(await match(one, newer, 12)).toEqual(expect.any(String));
    expect(await offsetOf(one)).toBe("12");
    expect(await offsetOf(two)).toBe("0");
    await match(one, null, 3);
    expect(await offsetOf(one)).toBe("12");
  });
});

describe("the claim of a bot that has a channel (floor)", () => {
  it("is released when the last challenge of a bot with no channel ends", async () => {
    const mine = bot("release");
    await put(U.admin, WA, `release-${randomUUID()}`, mine);
    expect(await putError(U.bOwner, WB, `rival-${randomUUID()}`, mine)).toMatchObject({ code: "SH409" });
    await rows(
      "UPDATE app.connect_challenges SET expires_at = now() - interval '1 second' WHERE bot_digest = $1",
      [mine],
    );
    expect(await putError(U.bOwner, WB, `rival-${randomUUID()}`, mine)).toBeUndefined();
  });

  it("is released when the last channel of that bot is deleted", async () => {
    const mine = bot("channel");
    await put(U.admin, WA, `channel-${randomUUID()}`, mine);
    const [channel] = await rows(
      `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name)
       VALUES ($1, $3, 'bot', $2, 'Bot') RETURNING id`,
      [WA, `bot-${randomUUID()}`, PROVIDER],
    );
    await rows(
      `INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv,
         ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, bot_digest)
       VALUES ($1, $2, 1, 'bot_token', 1, 'k1', $3, $4, $5, $6, $7, $8, $9)`,
      [WA, channel?.id, ...sealedColumns().slice(2), mine],
    );
    await rows(
      "UPDATE app.connect_challenges SET expires_at = now() - interval '1 second' WHERE bot_digest = $1",
      [mine],
    );
    expect(await putError(U.bOwner, WB, `rival-${randomUUID()}`, mine)).toMatchObject({ code: "SH409" });
    await rows("DELETE FROM app.channels WHERE id = $1", [channel?.id]);
    expect(await rows("SELECT 1 FROM app.bot_claims WHERE bot_digest = $1", [mine])).toEqual([]);
    expect(await putError(U.bOwner, WB, `rival-${randomUUID()}`, mine)).toBeUndefined();
  });
});

describe("a claim taken while another session releases it (floor)", () => {
  it("never answers that the claim is held when no row holds it", async () => {
    // Two connections serve every round: opening new ones per round made the test cost depend on the host's load.
    await withAdminClient(env, db.name, (claimer) =>
      withAdminClient(env, db.name, async (releaser) => {
        for (let round = 0; round < 60; round++) {
          const digest = bot(`race-${round}`);
          await releaser.query("INSERT INTO app.bot_claims (bot_digest, workspace_id) VALUES ($1, $2)", [
            digest,
            WA,
          ]);
          const claim = (async () => {
            await claimer.query("BEGIN");
            const answer = await claimer.query("SELECT app.bot_claim($1, $2) AS held", [digest, WB]);
            const holder = await claimer.query(
              "SELECT workspace_id FROM app.bot_claims WHERE bot_digest = $1",
              [digest],
            );
            await claimer.query("COMMIT");
            return { held: answer.rows[0]?.held, holder: holder.rows[0]?.workspace_id };
          })();
          const release = releaser.query("DELETE FROM app.bot_claims WHERE bot_digest = $1", [digest]);
          const [claimed] = await Promise.all([claim, release]);
          expect(claimed.held).toBe(true);
          expect(claimed.holder).toBe(WB);
        }
      }),
    );
  });
});

describe("a renewed challenge (floor)", () => {
  const RENEW = "SELECT app.connect_challenge_renew($1, $2, $3, $4) AS expires";
  const renew = (user: string, ws: string, provider: string, id: unknown, word: string) =>
    commit("app", asUser(user), RENEW, [ws, provider, id, digestOf(word)]);

  it("refuses the old word, takes the new one and lasts 10 more minutes on the same row", async () => {
    const mine = bot("renew");
    const [older, newer] = [`older-${randomUUID()}`, `newer-${randomUUID()}`];
    const [{ id }] = (await put(U.admin, WA, older, mine)) as [{ id: string }];
    await rows("UPDATE app.connect_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [
      id,
    ]);
    expect(await status(U.admin, WA, id)).toMatchObject({ state: "expired" });
    const [{ expires }] = (await renew(U.admin, WA, PROVIDER, id, newer)) as [{ expires: Date }];
    expect(expires.getTime() - Date.now()).toBeGreaterThan(590_000);
    expect(await match(mine, older, 1)).toBeNull();
    expect(await match(mine, newer, 2)).toBe(id);
    expect(await status(U.admin, WA, id)).toMatchObject({ state: "matched" });
  });

  it.each([
    ["another provider", WA, OTHER_PROVIDER, U.admin],
    ["another workspace", WB, PROVIDER, U.bOwner],
  ])("is refused for %s with no change", async (_name, ws, provider, user) => {
    const mine = bot("renew-refused");
    const [{ id }] = (await put(U.admin, WA, `word-${randomUUID()}`, mine)) as [{ id: string }];
    expect(await renew(user, ws, provider, id, `new-${randomUUID()}`)).toEqual([{ expires: null }]);
  });

  it("is not available to an Editor (42501) or after a chat answered", async () => {
    const mine = bot("renew-matched");
    const word = `word-${randomUUID()}`;
    const [{ id }] = (await put(U.admin, WA, word, mine)) as [{ id: string }];
    await expect(renew(U.editor, WA, PROVIDER, id, `new-${randomUUID()}`)).rejects.toMatchObject({
      code: "42501",
    });
    await match(mine, word, 1);
    expect(await renew(U.admin, WA, PROVIDER, id, `new-${randomUUID()}`)).toEqual([{ expires: null }]);
  });
});

describe("the challenge word (floor)", () => {
  it("is single use, expires at 10 minutes and matches only its workspace and provider", async () => {
    const [mine, theirs] = [bot("word"), bot("word-b")];
    const word = `word-${randomUUID()}`;
    const [{ id }] = (await put(U.admin, WA, word, mine)) as [{ id: string }];
    const [{ id: theirId }] = (await put(U.bOwner, WB, word, theirs)) as [{ id: string }];
    expect(await match(theirs, word, 1)).toEqual(expect.any(String));
    expect(await take(WA, PROVIDER, id, word)).toEqual([]);
    expect(await take(WB, OTHER_PROVIDER, theirId, word)).toEqual([]);
    expect(await match(mine, word, 2)).toEqual(expect.any(String));
    expect(await take(WA, PROVIDER, theirId, word)).toEqual([]);
    expect(await take(WA, PROVIDER, id, word)).toMatchObject([
      { matched_chat_id: "-1001", matched_title: "Team chat" },
    ]);
    expect(await take(WA, PROVIDER, id, word)).toEqual([]);
  });

  it("a word past its 10 minutes never matches or takes", async () => {
    const mine = bot("expired");
    const word = `expired-${randomUUID()}`;
    const [{ id }] = (await put(U.admin, WA, word, mine)) as [{ id: string }];
    await rows(
      "UPDATE app.connect_challenges SET expires_at = now() - interval '1 second' WHERE bot_digest = $1",
      [mine],
    );
    expect(await match(mine, word, 1)).toBeNull();
    expect(await take(WA, PROVIDER, id, word)).toEqual([]);
  });

  it("the challenge lasts 10 minutes from the database clock", async () => {
    const mine = bot("clock");
    const [{ id }] = (await put(U.admin, WA, `clock-${randomUUID()}`, mine)) as [{ id: string }];
    const [row] = await rows(
      "SELECT extract(epoch FROM expires_at - clock_timestamp())::int AS left FROM app.connect_challenges WHERE id = $1",
      [id],
    );
    expect(row?.left).toBeGreaterThan(590);
    expect(row?.left).toBeLessThanOrEqual(600);
  });
});

describe("the challenge definers see their rows", () => {
  it("open_due returns an unmatched challenge with its bot offset, and status shows waiting then matched", async () => {
    const mine = bot("due");
    const word = `due-${randomUUID()}`;
    const [{ id }] = (await put(U.admin, WA, word, mine)) as [{ id: string }];
    const due = await commit("worker", poller, "SELECT * FROM app.connect_challenge_open_due($1)", [50]);
    expect(due).toContainEqual(
      expect.objectContaining({ id, workspace_id: WA, provider_id: PROVIDER, update_offset: "0" }),
    );
    expect(await status(U.admin, WA, id)).toMatchObject({ state: "waiting" });
    await match(mine, word, 4);
    expect(await status(U.admin, WA, id)).toMatchObject({ state: "matched", matched_title: "Team chat" });
    expect(await status(U.bOwner, WB, id)).toBeUndefined();
    expect(await status(U.admin, WA, id, OTHER_PROVIDER)).toBeUndefined();
  });
});

describe("what the status says of a challenge that ended", () => {
  it("is ended for one a newer challenge of the bot replaced, and done only for one that connected", async () => {
    const mine = bot("replaced");
    const firstWord = `first-${randomUUID()}`;
    const [{ id: first }] = (await put(U.admin, WA, firstWord, mine)) as [{ id: string }];
    await match(mine, firstWord, 1);
    const word = `second-${randomUUID()}`;
    const [{ id: second }] = (await put(U.admin, WA, word, mine)) as [{ id: string }];
    expect(await status(U.admin, WA, first)).toMatchObject({ state: "ended" });
    await match(mine, word, 1);
    await take(WA, PROVIDER, second, word);
    expect(await status(U.admin, WA, second)).toMatchObject({ state: "done" });
  });
});

describe("the token of a challenge nobody finished", () => {
  it("is emptied by the poll once the challenge ended for an hour, and the row is no longer polled", async () => {
    const [kept, ended] = [bot("kept"), bot("ended")];
    const [{ id: keptId }] = (await put(U.admin, WA, `kept-${randomUUID()}`, kept)) as [{ id: string }];
    const [{ id: endedId }] = (await put(U.admin, WA, `ended-${randomUUID()}`, ended)) as [{ id: string }];
    await rows("UPDATE app.connect_challenges SET expires_at = now() - interval '5 minutes' WHERE id = $1", [
      keptId,
    ]);
    await rows("UPDATE app.connect_challenges SET expires_at = now() - interval '2 hours' WHERE id = $1", [
      endedId,
    ]);
    await commit("worker", poller, "SELECT * FROM app.connect_challenge_open_due($1)", [50]);
    const left = await rows(
      "SELECT id, ciphertext IS NULL AS emptied, iv IS NULL AS iv_empty FROM app.connect_challenges WHERE id = ANY($1)",
      [[keptId, endedId]],
    );
    expect(Object.fromEntries(left.map((row) => [row.id, [row.emptied, row.iv_empty]]))).toEqual({
      [keptId]: [false, false],
      [endedId]: [true, true],
    });
  });
});

describe("a word a chat sent that cannot be used yet (floor)", () => {
  it("records the reason on the open challenge whose word it is, without matching or consuming it, and the status shows it", async () => {
    const mine = bot("hold");
    const word = `hold-${randomUUID()}`;
    const [{ id }] = (await put(U.admin, WA, word, mine)) as [{ id: string }];
    expect(await hold(WA, mine, word, "bot_cannot_post")).toEqual([{ id }]);
    expect(await reasonOf(id)).toEqual({
      wait_reason: "bot_cannot_post",
      matched_chat_id: null,
      consumed_at: null,
    });
    expect(await status(U.admin, WA, id)).toMatchObject({ state: "waiting", reason: "bot_cannot_post" });
    expect(await match(mine, word, 1)).toBe(id);
    expect(await status(U.admin, WA, id)).toMatchObject({ state: "matched", reason: null });
  });

  it("never reaches another workspace's challenge that holds the same word, or a word of another bot", async () => {
    const [mine, theirs] = [bot("hold-a"), bot("hold-b")];
    const word = `shared-${randomUUID()}`;
    const [{ id }] = (await put(U.admin, WA, word, mine)) as [{ id: string }];
    const [{ id: theirId }] = (await put(U.bOwner, WB, word, theirs)) as [{ id: string }];
    expect(await hold(WB, mine, word, "bot_cannot_post")).toEqual([{ id: null }]);
    expect(await hold(WA, theirs, word, "bot_cannot_post")).toEqual([{ id: null }]);
    expect(await hold(WA, mine, `other-${randomUUID()}`, "bot_cannot_post")).toEqual([{ id: null }]);
    expect([(await reasonOf(id))?.wait_reason, (await reasonOf(theirId))?.wait_reason]).toEqual([null, null]);
    expect(await hold(WA, mine, word, "bot_cannot_post")).toEqual([{ id }]);
    expect((await reasonOf(theirId))?.wait_reason).toBeNull();
    expect(await status(U.bOwner, WB, theirId)).toMatchObject({ state: "waiting", reason: null });
  });
});

describe("what a held word does not reach (floor)", () => {
  it("holds nothing for a challenge a chat already answered or that expired", async () => {
    const [answered, late] = [bot("hold-answered"), bot("hold-late")];
    const [wordA, wordB] = [`answered-${randomUUID()}`, `late-${randomUUID()}`];
    const [{ id: answeredId }] = (await put(U.admin, WA, wordA, answered)) as [{ id: string }];
    const [{ id: lateId }] = (await put(U.admin, WA, wordB, late)) as [{ id: string }];
    await match(answered, wordA, 1);
    await rows("UPDATE app.connect_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [
      lateId,
    ]);
    expect(await hold(WA, answered, wordA, "bot_cannot_post")).toEqual([{ id: null }]);
    expect(await hold(WA, late, wordB, "bot_cannot_post")).toEqual([{ id: null }]);
    expect([(await reasonOf(answeredId))?.wait_reason, (await reasonOf(lateId))?.wait_reason]).toEqual([
      null,
      null,
    ]);
  });

  it("takes only the closed reason, and only from the poll", async () => {
    const mine = bot("hold-closed");
    const word = `closed-${randomUUID()}`;
    await put(U.admin, WA, word, mine);
    await expect(hold(WA, mine, word, "anything else")).rejects.toMatchObject({ code: "22023" });
    await expect(hold(WA, mine, word, "bot_cannot_post", job([WA]))).rejects.toMatchObject({ code: "42501" });
    await expect(
      commit("app", asUser(U.admin), HOLD, [WA, PROVIDER, mine, digestOf(word), "bot_cannot_post"]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("is forgotten when a new word is asked for", async () => {
    const mine = bot("hold-renew");
    const word = `renew-${randomUUID()}`;
    const [{ id }] = (await put(U.admin, WA, word, mine)) as [{ id: string }];
    await hold(WA, mine, word, "bot_cannot_post");
    await rows("UPDATE app.connect_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [
      id,
    ]);
    await commit("app", asUser(U.admin), "SELECT app.connect_challenge_renew($1, $2, $3, $4)", [
      WA,
      PROVIDER,
      id,
      digestOf(`new-${randomUUID()}`),
    ]);
    expect((await reasonOf(id))?.wait_reason).toBeNull();
  });
});
