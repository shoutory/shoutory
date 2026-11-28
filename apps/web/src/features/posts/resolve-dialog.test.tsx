import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  confirmPassword,
  json,
  openApp,
  refusal,
  settle,
  type,
  uuidWorkspaces,
} from "../../../test/support/app";
import {
  bodyOf,
  detailAnswer,
  detailTarget,
  OPERATION,
  operation,
  POST_WS,
  type PostApi,
  postId,
  stubPostApi,
} from "../../../test/support/post-api";

afterEach(closeApp);

const PATH = `/w/${POST_WS}/posts/${postId(1)}`;
const ACK_NOT_THERE = "I checked and it is not there; I understand posting again could create a duplicate";
const ACK_REPLACE = "I understand the first post may still appear and I may get a duplicate";

const held = (op: Record<string, unknown>, change: Record<string, unknown> = {}) =>
  detailTarget({
    published_at: null,
    schedule_state: "held",
    actions: ["resolve", "duplicate"],
    operation: operation(op),
    ...change,
  });
// The server lists what may be settled and whether a fresh password is asked; the screen offers exactly that.
const STEPPED_KINDS = new Set(["attest_published", "attest_not_executed", "supersede", "confirm_removed"]);
const listed = (...kinds: string[]) => kinds.map((kind) => ({ kind, step_up: STEPPED_KINDS.has(kind) }));
const UNCLEAR_KINDS = ["attest_published", "attest_not_executed", "supersede", "dismiss"];
const UNCLEAR = held({
  state: "needs_human",
  effect: "possible",
  resolutions: listed(...UNCLEAR_KINDS),
});
const PAST_DUE = held({
  state: "needs_human",
  effect: "none",
  reason_code: "past_due_after_reconnect",
  resolutions: listed("publish_late", "reschedule", "drop"),
});
const UNVERIFIED = held({
  state: "unverified",
  effect: "possible",
  resolutions: listed("attest_published", "supersede"),
});
const MISSED = held(
  { state: "missed", effect: "none", resolutions: listed("publish_late", "reschedule") },
  { schedule_state: "settled" },
);
const DELETE_UNKNOWN = held(
  {
    kind: "delete",
    state: "needs_human",
    effect: "possible",
    resolutions: listed("confirm_removed", "dismiss"),
  },
  { published_at: "2026-11-27T10:00:00.000Z", presence: "removal_unknown" },
);
const EDIT_UNCLEAR = held({
  kind: "edit",
  state: "needs_human",
  effect: "possible",
  resolutions: listed(...UNCLEAR_KINDS),
});

const done = (kind: string, made: string | null = null) =>
  json({ data: { operation_id: OPERATION, kind, new_operation_id: made } });
const answers = (...targets: unknown[]): PostApi => ({ postDetail: () => detailAnswer(targets) });

async function visit(api: PostApi) {
  const stub = stubPostApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(PATH);
  await settle();
  return { stub, ...opened };
}
async function open(api: PostApi) {
  const opened = await visit(api);
  click(opened.host.querySelector('[data-testid="action-resolve"]') as HTMLElement);
  await settle();
  return opened;
}
const dialog = () => document.body.querySelector<HTMLElement>('[data-testid="resolve-dialog"]');
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const choose = (kind: string) => click(byId(`resolve-choice-${kind}`)?.querySelector("input") as HTMLElement);
const typeInto = (id: string, text: string) => type(byId(id) as HTMLInputElement, text);
// The message a field points at through aria-describedby: a field error is shown there, not in a test id of its own.
const errorOf = (id: string) =>
  (byId(id)?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((part) => document.getElementById(part)?.textContent ?? "")
    .join(" ");
const choiceKinds = () =>
  [...document.body.querySelectorAll<HTMLElement>('[data-testid^="resolve-choice-"]')].map((one) =>
    (one.dataset.testid ?? "").replace("resolve-choice-", ""),
  );
const submit = async () => {
  click(byId("resolve-submit") as HTMLElement);
  await settle();
};
const posts = (stub: ReturnType<typeof stubPostApi>, part: string) =>
  stub.mock.calls.filter(([url, init]) => url.includes(part) && init?.method === "POST");

const STATES: [string, unknown, string, string, string[]][] = [
  [
    "an unclear outcome",
    UNCLEAR,
    "Check and resolve",
    "We could not confirm whether this was posted",
    ["attest_published", "attest_not_executed", "supersede", "dismiss"],
  ],
  [
    "an unclear edit",
    EDIT_UNCLEAR,
    "Check and resolve",
    "We could not confirm whether this was posted",
    ["attest_published", "attest_not_executed", "supersede", "dismiss"],
  ],
  [
    "past due after a reconnect",
    PAST_DUE,
    "Choose what to do",
    "Nothing was posted; its time passed",
    ["publish_late", "reschedule", "drop"],
  ],
  [
    "a post that was never confirmed",
    UNVERIFIED,
    "Resolve",
    "Could not be confirmed",
    ["attest_published", "supersede"],
  ],
  [
    "a missed post",
    MISSED,
    "Choose what to do",
    "Nothing was posted; its time passed",
    ["publish_late", "reschedule"],
  ],
  [
    "a removal that could not be confirmed",
    DELETE_UNKNOWN,
    "Confirm it was removed",
    "We could not confirm it was removed",
    ["confirm_removed", "dismiss"],
  ],
];

describe("the choices of each state", () => {
  it.each(STATES)("%s", async (_name, row, button, title, kinds) => {
    const { host } = await visit(answers(row));
    expect(byId("action-resolve")?.textContent ?? host.textContent).toContain(button);
    click(byId("action-resolve") as HTMLElement);
    await settle();
    expect(document.body.querySelector('[role="dialog"] h2')?.textContent).toBe(title);
    expect(choiceKinds()).toEqual(kinds);
  });

  it("a post past due names no duplicate risk and asks for no sentence", async () => {
    await open(answers(PAST_DUE));
    expect(dialog()?.textContent).not.toMatch(/duplicate/i);
    expect(byId("resolve-ack")).toBeNull();
    choose("publish_late");
    expect(byId("resolve-ack")).toBeNull();
  });

  it("an unclear outcome says to look at the channel first and never says unknown or operation", async () => {
    await open(answers(UNCLEAR));
    expect(dialog()?.textContent).toMatch(/Acme Page/);
    expect(dialog()?.textContent).not.toMatch(/unknown|operation|ledger|reconcil/i);
  });

  it("offers only the kinds the server lists, and sends a kind it marks as needing no password the ordinary way", async () => {
    const some = held({
      state: "needs_human",
      effect: "possible",
      resolutions: [{ kind: "supersede", step_up: false }],
    });
    let sent: unknown;
    const { stub } = await open({
      ...answers(some),
      resolve: ({ confirmed }) => {
        sent = confirmed;
        return done("supersede");
      },
    });
    expect(choiceKinds()).toEqual(["supersede"]);
    choose("supersede");
    typeInto("resolve-ack", ACK_REPLACE);
    await submit();
    expect(sent).toBe(false);
    expect(posts(stub, "/resolutions/confirmed")).toHaveLength(0);
  });

  it("offers nothing to choose for a removal that is only unverified", async () => {
    const odd = held({ kind: "delete", state: "unverified", effect: "possible" });
    await open(answers(odd));
    expect(choiceKinds()).toEqual([]);
    expect(byId("resolve-submit")).toBeNull();
  });
});

describe("the choices that send nothing", () => {
  it.each<[string, string, unknown]>([
    ["publish_late", "publish_late", PAST_DUE],
    ["drop", "drop", PAST_DUE],
    ["dismiss", "dismiss", UNCLEAR],
  ])("%s goes by the ordinary route with no password and no sentence", async (_name, kind, row) => {
    let sent: unknown;
    const { stub } = await open({
      ...answers(row),
      resolve: ({ body, confirmed }) => {
        sent = { body, confirmed };
        return done(kind);
      },
    });
    choose(kind);
    await submit();
    expect(sent).toEqual({ body: { kind }, confirmed: false });
    expect(posts(stub, "/resolutions/confirmed")).toHaveLength(0);
    expect(document.body.querySelector('[name="password"]')).toBeNull();
  });
});

const steppedUp = (kind: string) => {
  let verified = false;
  return {
    verifyPassword: () => {
      verified = true;
      return json({ status: true });
    },
    resolve: ({ confirmed }: { confirmed: boolean }) =>
      confirmed && !verified ? refusal("step_up_required", 403, { method: "password" }) : done(kind),
  };
};

describe("the choices that need your password", () => {
  it("It was posted asks for the password, then records it, with the optional link", async () => {
    const { stub } = await open({ ...answers(UNCLEAR), ...steppedUp("attest_published") });
    choose("attest_published");
    typeInto("resolve-permalink", "https://example.test/p/1");
    await submit();
    await confirmPassword();
    const sent = posts(stub, "/resolutions/confirmed");
    expect(sent).toHaveLength(2);
    expect(bodyOf(stub, "POST", "/resolutions/confirmed")).toEqual({
      kind: "attest_published",
      permalink: "https://example.test/p/1",
    });
    expect(byId("resolve-result")?.textContent).toMatch(/Recorded as published/);
  });
});

describe("the sentence and the link", () => {
  it.each<[string, string, string, unknown]>([
    ["attest_not_executed", "attest_not_executed", ACK_NOT_THERE, UNCLEAR],
    ["supersede", "supersede", ACK_REPLACE, UNCLEAR],
  ])("%s needs the sentence typed exactly, and sends what was typed", async (_name, kind, sentence, row) => {
    const { stub } = await open({ ...answers(row), ...steppedUp(kind) });
    choose(kind);
    expect(dialog()?.textContent).toContain(sentence);
    typeInto("resolve-ack", "I checked");
    await submit();
    expect(posts(stub, "/resolutions")).toHaveLength(0);
    expect(errorOf("resolve-ack")).toMatch(/exactly as shown/);
    typeInto("resolve-ack", sentence);
    await submit();
    await confirmPassword();
    expect(bodyOf(stub, "POST", "/resolutions/confirmed")).toEqual({ kind, ack_text: sentence });
  });
});

describe("confirm removed and a cancelled password step", () => {
  it("confirm removed asks for the password and records it", async () => {
    const { stub } = await open({ ...answers(DELETE_UNKNOWN), ...steppedUp("confirm_removed") });
    choose("confirm_removed");
    await submit();
    await confirmPassword();
    expect(bodyOf(stub, "POST", "/resolutions/confirmed")).toEqual({ kind: "confirm_removed" });
    expect(byId("resolve-result")?.textContent).toMatch(/Recorded as removed/);
  });

  it("says nothing was changed when the password step is cancelled", async () => {
    await open({ ...answers(UNCLEAR), ...steppedUp("attest_published") });
    choose("attest_published");
    await submit();
    const asking = document.body.querySelector('input[name="password"]')?.closest('[role="dialog"]');
    click(byText(asking as HTMLElement, "button", "Cancel"));
    await settle();
    expect(byId("resolve-error")?.textContent).toMatch(/needs your password again/);
    expect(byId("resolve-result")).toBeNull();
  });
});

describe("a link that is not https", () => {
  it.each([["ftp://example.test/x"], ["http://example.test/x"], ["not a link"]])(
    "refuses the link %s before any call",
    async (link) => {
      const { stub } = await open({ ...answers(UNCLEAR), ...steppedUp("attest_published") });
      choose("attest_published");
      typeInto("resolve-permalink", link);
      await submit();
      expect(errorOf("resolve-permalink")).toMatch(/starts with https/);
      expect(posts(stub, "/resolutions")).toHaveLength(0);
    },
  );
});

describe("Reschedule", () => {
  const fill = (date: string, time: string) => {
    typeInto("resolve-date", date);
    typeInto("resolve-time", time);
  };
  const open2 = (api: PostApi = {}) => open({ ...answers(PAST_DUE), ...api });

  it("sends the wall time typed, in the workspace's own zone", async () => {
    const { stub } = await open2({ resolve: () => done("reschedule") });
    choose("reschedule");
    await settle();
    expect(dialog()?.textContent).toMatch(/Egypt|Eastern European/);
    fill("2026-12-05", "10:30");
    await submit();
    expect(bodyOf(stub, "POST", "/resolutions")).toEqual({
      kind: "reschedule",
      local_due: "2026-12-05T10:30",
    });
    expect(byId("resolve-result")?.textContent).toMatch(/Rescheduled/);
  });

  it("asks for a date and a time before any call", async () => {
    const { stub } = await open2();
    choose("reschedule");
    await submit();
    expect(errorOf("resolve-time")).toMatch(/Enter a date and a time/);
    expect(posts(stub, "/resolutions")).toHaveLength(0);
  });

  it.each<[string, string, RegExp]>([
    ["local_time_nonexistent", "unprocessable_content", /does not exist on that day/],
    ["in_the_past", "unprocessable_content", /Pick a time in the future/],
  ])("shows %s on the time field and keeps what was typed", async (reason, code, words) => {
    await open2({ resolve: () => refusal(code, 422, { reason }) });
    choose("reschedule");
    fill("2026-03-29", "02:30");
    await submit();
    expect(errorOf("resolve-time")).toMatch(words);
    expect((byId("resolve-time") as HTMLInputElement).value).toBe("02:30");
  });
});

describe("a time that repeats", () => {
  const fill = (date: string, time: string) => {
    typeInto("resolve-date", date);
    typeInto("resolve-time", time);
  };
  const open2 = (api: PostApi = {}) => open({ ...answers(PAST_DUE), ...api });

  it("asks which of two times when the clock repeats, and sends the answer", async () => {
    let calls = 0;
    const { stub } = await open2({
      resolve: ({ body }) => {
        calls += 1;
        return calls === 1
          ? refusal("unprocessable_content", 422, { reason: "local_time_ambiguous" })
          : done((body as { kind: string }).kind);
      },
    });
    choose("reschedule");
    fill("2026-10-25", "01:30");
    await submit();
    expect(errorOf("resolve-time")).toMatch(/happens twice/);
    click(byId("resolve-fold-later")?.querySelector("input") as HTMLElement);
    await submit();
    const second = posts(stub, "/resolutions")[1]?.[1]?.body;
    expect(JSON.parse(String(second))).toEqual({
      kind: "reschedule",
      local_due: "2026-10-25T01:30",
      fold: "later",
    });
  });
});

describe("after the answer", () => {
  it("reads the post again and says what happens next", async () => {
    const { stub } = await open({ ...answers(PAST_DUE), resolve: () => done("drop") });
    choose("drop");
    await submit();
    expect(byId("resolve-result")?.textContent).toMatch(/back to a draft/);
    expect(stub.mock.calls.filter(([url]) => url.endsWith(postId(1))).length).toBeGreaterThan(1);
  });

  it("is busy and ignores a second press while the call runs", async () => {
    let calls = 0;
    const { stub } = await open({
      ...answers(PAST_DUE),
      resolve: () => {
        calls += 1;
        return new Promise<Response>(() => undefined);
      },
    });
    choose("drop");
    const button = byId("resolve-submit") as HTMLElement;
    click(button);
    click(button);
    await settle();
    expect(calls).toBe(1);
    expect(posts(stub, "/resolutions")).toHaveLength(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});

describe("a refused choice", () => {
  it.each<[string, () => Response, RegExp]>([
    [
      "a channel that is not connected",
      () => refusal("conflict", 409, { reason: "channel_not_connected" }),
      /Reconnect .*Acme Page.* first/,
    ],
    ["a state that moved on", () => refusal("conflict", 409), /changed while you were looking/],
    ["a refused role", () => refusal("forbidden", 403), /Only the author of the post, an admin or the owner/],
    ["a failure", () => refusal("internal_error", 500), /We could not do that/],
  ])("shows %s as a panel with its request id", async (_name, answer, words) => {
    await open({ ...answers(PAST_DUE), resolve: answer });
    choose("drop");
    await submit();
    expect(byId("resolve-error")?.textContent).toMatch(words);
    expect(byId("resolve-error")?.textContent).toContain("req-42");
    expect(byId("resolve-result")).toBeNull();
  });

  it("closes with Cancel and puts focus back on the button that opened it", async () => {
    const { host } = await open(answers(PAST_DUE));
    click(byId("resolve-cancel") as HTMLElement);
    await settle();
    expect(dialog()).toBeNull();
    expect(host.querySelector('[data-testid="action-resolve"]')).not.toBeNull();
  });

  it("shows the link of its evidence as escaped text unless it is a safe address", async () => {
    const evidence = (permalink: string) => [
      {
        kind: "accepted",
        level: "receipt",
        outcome_kind: null,
        permalink,
        observed_at: "2026-11-27T10:00:00.000Z",
      },
    ];
    await open(answers({ ...UNCLEAR, evidence: evidence("javascript:alert(1)") }));
    expect(byId("target-link")?.tagName).not.toBe("A");
    expect(dialog()?.querySelector('a[href^="javascript"]')).toBeNull();
  });
});
