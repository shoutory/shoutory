import { inspect } from "node:util";
import { SealedSecret } from "@shoutory/core/crypto";
import type { AdapterContext } from "@shoutory/provider-sdk/adapter";
import { describe, expect, it, vi } from "vitest";
import {
  accountOf,
  json,
  MESSAGE_ID,
  type Scripted,
  scripted,
  WEBHOOK_ID,
  WEBHOOK_TOKEN,
  WEBHOOK_URL,
} from "../test/support/webhook.js";
import { createDiscordAdapter } from "./adapter.js";

const adapter = createDiscordAdapter();
const forms = (value: string) => [
  value,
  encodeURIComponent(value),
  Buffer.from(value).toString("hex"),
  Buffer.from(value).toString("base64"),
  JSON.stringify(value).slice(1, -1),
];

// The webhook object and the message both name the URL and token in their bodies; none of it may be handed on.
const echo = { webhook_url: WEBHOOK_URL, token: WEBHOOK_TOKEN, note: `${WEBHOOK_URL} ${WEBHOOK_TOKEN}` };
const webhook = { id: WEBHOOK_ID, type: 1, name: "Announcements", channel_id: "323456789012345678", ...echo };
const message = { id: MESSAGE_ID, content: "canary text", ...echo };

type Call = (context: AdapterContext) => Promise<{ ok: boolean }> | undefined;
const post = { externalId: MESSAGE_ID, account: accountOf() };
const CALLS: readonly [string, Call, () => Response][] = [
  [
    "connect",
    (context) =>
      adapter.connect?.verifySecret?.(context, {
        kind: "webhook_url",
        secret: new SealedSecret(WEBHOOK_URL),
      }),
    () => json(200, webhook),
  ],
  [
    "commit",
    (context) =>
      adapter.commit(context, { idempotencyKey: "leak-1", text: "canary text", account: accountOf() }),
    () => json(200, message),
  ],
  ["readBack", (context) => adapter.readBack(context, post), () => json(200, message)],
  ["readSource", (context) => adapter.readSource?.(context, post), () => json(200, message)],
  ["edit", (context) => adapter.edit?.(context, post, { text: "canary text" }), () => json(200, message)],
  ["delete", (context) => adapter.delete(context, post), () => new Response(null, { status: 204 })],
  [
    "inspect",
    (context) => adapter.inspect(context, { accessToken: new SealedSecret(WEBHOOK_URL) }),
    () => json(200, webhook),
  ],
];

const FAULTS: readonly [string, () => Scripted][] = [
  ["a 500", () => json(500, { message: `boom ${WEBHOOK_URL}`, ...echo })],
  ["a 401", () => json(401, { code: 50027, message: `${WEBHOOK_TOKEN} invalid`, ...echo })],
  ["a 404 for an unknown webhook", () => json(404, { code: 10015, message: WEBHOOK_URL, ...echo })],
  [
    "a 429",
    () => json(429, { retry_after: 1.5, global: false, message: WEBHOOK_URL }, { "retry-after": "2" }),
  ],
  [
    "a lost connection",
    () => Object.assign(new Error(`socket closed for ${WEBHOOK_URL}`), { name: "TimeoutError" }),
  ],
];

async function captured<T>(run: () => Promise<T> | undefined) {
  const logged: string[] = [];
  const keep = (chunk: unknown) => void logged.push(String(chunk));
  const spies = [
    ...(["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(keep),
    ),
    ...[process.stdout, process.stderr].map((stream) =>
      vi.spyOn(stream, "write").mockImplementation((chunk) => {
        keep(chunk);
        return true;
      }),
    ),
  ];
  try {
    return { answer: await run(), logged };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

const ROWS = CALLS.flatMap(([call, run, success]) => {
  const replies: [string, Scripted][] = [
    ["a success", success()],
    ...FAULTS.map(([name, fault]): [string, Scripted] => [name, fault()]),
  ];
  return replies.map(([name, reply]) => [call, name, run, reply] as const);
});

describe("the webhook URL is in no result, error or log line (floor)", () => {
  it.each(ROWS)("%s with %s", async (_call, name, run, reply) => {
    const { context } = scripted([reply]);
    const { answer, logged } = await captured(() => run(context));
    expect(answer, "the call answered").toBeDefined();
    if (name === "a success") expect(answer?.ok, "a documented answer is accepted").toBe(true);
    const shown = `${inspect(answer, { depth: null })} ${JSON.stringify(answer)} ${logged.join("\n")}`;
    for (const secret of [WEBHOOK_URL, WEBHOOK_TOKEN])
      for (const form of forms(secret)) expect(shown).not.toContain(form);
  });
});
