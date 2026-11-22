import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECT_CHANNEL,
  CONNECT_WS,
  callsTo,
  channelRow,
  closeApp,
  json,
  openApp,
  refusal,
  settle,
  stubApi,
  uuidWorkspaces,
} from "../../../test/support/app";

afterEach(closeApp);

// The connect result page: where the OAuth callback sends the browser. It reads only the parameters the server writes
// (`reason`, `channel`, `workspace`, and `message` for a provider's error), says "connected" only after its own read of
// the channel says so, and shows a provider's words as text in Details, never as markup and never as the headline.
// Elements are selected by test id (`connect-outcome` with `data-outcome`, `outcome-heading`, `connect-meaning`,
// `connect-link`, `provider-message`, `expected-handle`, `connected-name`, `channel-state`, `connect-live`).

type Pairs = Array<[string, string]>;
const OTHER_WS = "0190a000-0000-7000-8000-0000000000c2";
const WORDS = "the provider's own words";
const byId = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const outcomeOf = (host: ParentNode) => byId(host, "connect-outcome")?.dataset.outcome;
const hrefOf = (host: ParentNode) => byId(host, "connect-link")?.getAttribute("href");
const reads = (stub: ReturnType<typeof stubApi>) => callsTo(stub, "GET", "/channels/");

async function visit(pairs: Pairs, api: Parameters<typeof stubApi>[0] = {}) {
  const stub = stubApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(`/connect/result?${new URLSearchParams(pairs)}`);
  await settle();
  return { stub, ...opened };
}
function deferred() {
  let release: (answer: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

const WS: [string, string] = ["workspace", CONNECT_WS];
const CH: [string, string] = ["channel", CONNECT_CHANNEL];
// The key set the server writes for each reason (a refusal of the flow's own take carries no workspace).
const REASONS: Array<[reason: string, pairs: Pairs, reads: number]> = [
  ["start_again", [["reason", "start_again"]], 0],
  ["refused", [["reason", "refused"], WS], 0],
  ["provider_error", [["reason", "provider_error"], ["message", "Access denied"], WS], 0],
  ["failed", [["reason", "failed"], WS], 0],
  ["sign_in", [["reason", "sign_in"]], 0],
  ["rate_limited", [["reason", "rate_limited"]], 0],
  ["unavailable", [["reason", "unavailable"]], 0],
  ["wrong_account", [["reason", "wrong_account"], CH, WS], 1],
];

describe("each reason of the redirect", () => {
  it.each(REASONS)(
    "%s shows its outcome with a headline, a meaning, one link, and reads the channel only for wrong_account",
    async (reason, pairs, expectedReads) => {
      const { host, stub } = await visit(pairs);
      expect(outcomeOf(host)).toBe(reason);
      expect(byId(host, "outcome-heading")?.textContent?.length).toBeGreaterThan(0);
      expect(byId(host, "connect-meaning")?.textContent?.length).toBeGreaterThan(0);
      expect(byId(host, "connect-outcome")?.querySelectorAll("a")).toHaveLength(1);
      expect(byId(host, "connected-name")).toBeNull();
      expect(reads(stub)).toHaveLength(expectedReads);
    },
  );

  it("has its own headline per reason, and a rate limit names no wait time", async () => {
    const headlines: string[] = [];
    for (const [reason, pairs] of REASONS) {
      const { host } = await visit(pairs);
      headlines.push(byId(host, "outcome-heading")?.textContent ?? "");
      if (reason === "rate_limited") expect(byId(host, "connect-meaning")?.textContent).not.toMatch(/\d/);
      closeApp();
    }
    expect(new Set(headlines).size).toBe(REASONS.length);
  });
});

// Security floor: anything the server does not write is the generic failure, never success, and costs no read.
describe("a redirect the server would not write is the generic failure", () => {
  it.each<[string, Pairs]>([
    ["an unknown reason", [["reason", "bogus"], WS]],
    ["a duplicated reason", [["reason", "failed"], ["reason", "refused"], WS]],
    ["a reason beside a channel", [["reason", "refused"], CH, WS]],
    ["a channel that is not a UUID", [["channel", "w1"], WS]],
    ["two channels", [CH, ["channel", OTHER_WS], WS]],
    ["no parameter at all", []],
    ["a workspace alone", [WS]],
    ["a provider error without its message", [["reason", "provider_error"], WS]],
    ["a provider error with an empty message", [["reason", "provider_error"], ["message", ""], WS]],
  ])("%s", async (_what, pairs) => {
    const { host, stub } = await visit(pairs);
    expect(outcomeOf(host)).toBe("generic");
    expect(byId(host, "connected-name")).toBeNull();
    expect(reads(stub)).toHaveLength(0);
  });

  it.each<[string, Pairs]>([
    ["another reason", [["reason", "failed"], ["message", WORDS], WS]],
    ["a channel", [CH, ["message", WORDS], WS]],
    ["a wrong account", [["reason", "wrong_account"], CH, ["message", WORDS], WS]],
  ])("a message beside %s is never read or shown", async (_what, pairs) => {
    const { host } = await visit(pairs);
    expect(outcomeOf(host)).toBe("generic");
    expect(host.textContent).not.toContain(WORDS);
  });
});

describe("a provider's words", () => {
  const MARKUP = '<img src="x" onerror="alert(1)"><b>bold</b> access denied';
  const visitWith = (message: string) => visit([["reason", "provider_error"], ["message", message], WS]);

  it("render as text inside Details, labelled as the provider's, and never in the headline or the meaning", async () => {
    const { host } = await visitWith(MARKUP);
    const shown = byId(host, "provider-message");
    expect(shown?.textContent).toBe(MARKUP);
    expect(shown?.closest("details")).not.toBeNull();
    expect(byId(host, "provider-message-label")).not.toBeNull();
    expect(byId(host, "connect-outcome")?.querySelector("img, b")).toBeNull();
    expect(byId(host, "outcome-heading")?.textContent).not.toContain("access denied");
    expect(byId(host, "connect-meaning")?.textContent).not.toContain("access denied");
  });

  it.each([
    ["ascii", "a".repeat(250), "a".repeat(200)],
    ["emoji (two UTF-16 units each)", "😀".repeat(250), "😀".repeat(200)],
    ["exactly 200", "b".repeat(200), "b".repeat(200)],
    ["a short one", "no", "no"],
  ])("are cut at 200 code points: %s", async (_name, sent, expected) => {
    const { host } = await visitWith(sent);
    expect(byId(host, "provider-message")?.textContent).toBe(expected);
  });
});

describe("a success is only what the channel read says", () => {
  const connected = () => [CH, WS] as Pairs;

  it("shows nothing as success while the read is pending, then the channel's name once it says connected", async () => {
    const pending = deferred();
    const { host, stub } = await visit(connected(), { channel: pending.answer });
    expect(outcomeOf(host)).toBe("pending");
    expect(byId(host, "connected-name")).toBeNull();
    pending.release(json({ data: channelRow() }));
    await settle();
    expect(outcomeOf(host)).toBe("connected");
    expect(host.querySelectorAll('[data-testid="connected-name"]')).toHaveLength(1);
    expect(byId(host, "connected-name")?.textContent).toContain("Acme Page");
    expect(reads(stub).map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${CONNECT_WS}/channels/${CONNECT_CHANNEL}`,
    ]);
  });

  it("names the channel by the user's own nickname when it has one", async () => {
    const { host } = await visit(connected(), {
      channel: () => json({ data: channelRow({ nickname: "Brand page" }) }),
    });
    expect(byId(host, "outcome-heading")?.textContent).toContain("Brand page");
    expect(byId(host, "outcome-heading")?.textContent).not.toContain("Acme Page");
  });

  it.each(["needs_reconnect", "disconnected", "revoked_by_provider", "disabled"])(
    "a channel read as %s shows that state, not success",
    async (state) => {
      const { host } = await visit(connected(), {
        channel: () => json({ data: channelRow({ connection_state: state }) }),
      });
      expect(outcomeOf(host)).toBe("channel_state");
      expect(byId(host, "channel-state")?.dataset.state).toBe(state);
      expect(byId(host, "connected-name")).toBeNull();
    },
  );

  it("a state the page does not know is not success either", async () => {
    const { host } = await visit(connected(), {
      channel: () => json({ data: channelRow({ connection_state: "a_state_not_known_yet" }) }),
    });
    expect(outcomeOf(host)).toBeTruthy();
    expect(outcomeOf(host)).not.toBe("connected");
    expect(byId(host, "connected-name")).toBeNull();
  });

  it.each([
    ["403", () => refusal("forbidden", 403)],
    ["404", () => refusal("not_found", 404)],
    ["500", () => refusal("internal_error", 500)],
  ])("a read answered %s is not success", async (_status, answer) => {
    const { host } = await visit(connected(), { channel: answer });
    expect(outcomeOf(host)).toBe("unconfirmed");
    expect(byId(host, "connected-name")).toBeNull();
  });
});

describe("a wrong account", () => {
  const pairs = (): Pairs => [["reason", "wrong_account"], CH, WS];

  it("names the handle the channel is connected as", async () => {
    const { host } = await visit(pairs());
    expect(byId(host, "expected-handle")?.textContent).toBe("@acme_page");
  });

  it("beside an unlisted workspace reads nothing, names no handle and links to the root", async () => {
    const { host, stub } = await visit([["reason", "wrong_account"], CH, ["workspace", OTHER_WS]]);
    expect(outcomeOf(host)).toBe("wrong_account");
    expect(byId(host, "expected-handle")).toBeNull();
    expect(reads(stub)).toHaveLength(0);
    expect(hrefOf(host)).toBe("/");
  });

  it.each([
    ["a failed read", () => refusal("internal_error", 500)],
    ["a 404", () => refusal("not_found", 404)],
  ])("keeps the headline without a handle after %s", async (_what, answer) => {
    const { host } = await visit(pairs(), { channel: answer });
    expect(outcomeOf(host)).toBe("wrong_account");
    expect(byId(host, "outcome-heading")?.textContent?.length).toBeGreaterThan(0);
    expect(byId(host, "expected-handle")).toBeNull();
  });
});

// Security floor: the one link is built from the shell's workspace list, and a workspace that is not listed is never read.
describe("the link and the reads follow the shell's workspace list", () => {
  const upper = CONNECT_WS.toUpperCase();
  it.each<[string, Pairs, string]>([
    ["a listed workspace", [["reason", "failed"], WS], `/w/${CONNECT_WS}/channels`],
    [
      "a UUID that is not listed",
      [
        ["reason", "failed"],
        ["workspace", OTHER_WS],
      ],
      "/",
    ],
    [
      "a listed workspace spelled in capitals",
      [
        ["reason", "failed"],
        ["workspace", upper],
      ],
      "/",
    ],
    ["no workspace", [["reason", "failed"]], "/"],
  ])("%s links where the list entry says, else to the root", async (_what, pairs, href) => {
    const { host } = await visit(pairs);
    expect(hrefOf(host)).toBe(href);
  });

  it("a workspace id that is listed but is not a UUID links to the root", async () => {
    stubApi();
    const { host } = await openApp(
      `/connect/result?${new URLSearchParams({ reason: "failed", workspace: "w1" })}`,
    );
    await settle();
    expect(hrefOf(host)).toBe("/");
  });

  it.each<[string, Pairs]>([
    ["an unlisted workspace", [CH, ["workspace", OTHER_WS]]],
    ["a workspace in capitals", [CH, ["workspace", upper]]],
    ["no workspace", [CH]],
  ])("a channel beside %s is not read, and is not confirmed", async (_what, pairs) => {
    const { host, stub } = await visit(pairs);
    expect(reads(stub)).toHaveLength(0);
    expect(outcomeOf(host)).toBe("unconfirmed");
    expect(hrefOf(host)).toBe("/");
    expect(byId(host, "connected-name")).toBeNull();
  });
});

describe("a visit with an ended session", () => {
  const asked = (pairs: Pairs) => `/connect/result?${new URLSearchParams(pairs)}`;
  const signIn = (path: string) => `?return-to=${encodeURIComponent(path)}`;

  it("goes to sign-in with the whole address, query included", async () => {
    const pairs: Pairs = [["reason", "failed"], WS];
    const { router } = await visit(pairs, {
      session: () => Promise.resolve(refusal("unauthenticated", 401)),
    });
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toBe(signIn(asked(pairs)));
  });

  it("goes to sign-in with the whole address when the session ends during the channel read", async () => {
    const pairs: Pairs = [CH, WS];
    const { router } = await visit(pairs, { channel: () => refusal("unauthenticated", 401) });
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toBe(signIn(asked(pairs)));
  });
});

describe("what a person is told after the read", () => {
  it("moves focus to the outcome heading, and announces it in a polite region that was there before the words", async () => {
    const pending = deferred();
    const { host } = await visit([CH, WS], { channel: pending.answer });
    const region = byId(host, "connect-live");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");
    pending.release(json({ data: channelRow() }));
    await settle();
    expect(byId(host, "connect-live")).toBe(region);
    // The focused heading says the headline, the region the meaning: a success is announced once, in different words.
    expect(region?.textContent?.length).toBeGreaterThan(0);
    expect(region?.textContent).toBe(byId(host, "connect-meaning")?.textContent);
    expect(region?.textContent).not.toContain("Acme Page");
    expect(document.activeElement).toBe(byId(host, "outcome-heading"));
  });
});
