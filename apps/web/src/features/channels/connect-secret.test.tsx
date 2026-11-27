import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Api,
  CHALLENGE_ID,
  CONNECT_WS,
  callsTo,
  challengeAnswer,
  channelPage,
  channelRow,
  click,
  closeApp,
  json,
  openApp,
  PROVIDERS,
  refusal,
  SECRET_CHANNEL,
  settle,
  stubApi,
  type,
  uuidWorkspaces,
} from "../../../test/support/app";

afterEach(() => {
  closeApp();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PATH = `/w/${CONNECT_WS}/channels`;
const RESULT = `/connect/result?channel=${SECRET_CHANNEL}&workspace=${CONNECT_WS}`;
const provider = (change: Record<string, unknown>) => ({
  ...PROVIDERS[0],
  id: "step_net",
  display_name: "Step Network",
  ...change,
});
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const field = (id: string) => byId(id) as HTMLInputElement;
const spyAssign = () => vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
const posts = (stub: ReturnType<typeof stubApi>, part: string) => callsTo(stub, "POST", part);
const bodyOf = (call: unknown) => JSON.parse(String((call as [string, RequestInit])[1].body));

async function open(row: Record<string, unknown>, api: Api = {}, locale: "en" | "ar" = "en") {
  const stub = stubApi({
    workspaces: uuidWorkspaces(),
    channelList: () => channelPage([channelRow()], null, ["connect"]),
    providers: () => json({ data: [provider(row)] }),
    ...api,
  });
  const opened = await openApp(PATH, locale);
  await settle();
  click(opened.host.querySelector<HTMLElement>('[data-testid="hub-add"]') as HTMLElement);
  await settle();
  click(byId("tile-start") as HTMLElement);
  await settle();
  return { stub, ...opened };
}
const submit = async (fieldId: string, buttonId: string, value: string) => {
  type(field(fieldId), value);
  click(byId(buttonId) as HTMLElement);
  await settle();
};

describe.each(["en", "ar"] as const)(
  "a platform that finds the account from what a person types (%s)",
  (locale) => {
    const hint = { needs_login_hint: true };

    it("asks for the account first, reads it left to right, and sends it as the login hint", async () => {
      const assign = spyAssign();
      const { stub } = await open(hint, {}, locale);
      expect(posts(stub, "/start")).toHaveLength(0);
      expect(document.activeElement).toBe(field("hint-field"));
      expect(field("hint-field").getAttribute("dir")).toBe("ltr");
      await submit("hint-field", "hint-continue", "  alice.example.test ");
      expect(bodyOf(posts(stub, "/start")[0])).toEqual({ login_hint: "alice.example.test" });
      expect(assign).toHaveBeenCalled();
    });

    it("sends nothing and says so when the field is empty", async () => {
      const { stub } = await open(hint, {}, locale);
      click(byId("hint-continue") as HTMLElement);
      await settle();
      expect(posts(stub, "/start")).toHaveLength(0);
      expect(byId("hint-field")?.getAttribute("aria-invalid")).toBe("true");
    });

    it("explains an install that is not reachable over public https and offers no way to continue", async () => {
      const { stub } = await open({ ...hint, needs_public_origin: true }, {}, locale);
      expect(byId("origin-explanation")).not.toBeNull();
      expect(byId("hint-continue")).toBeNull();
      expect(posts(stub, "/start")).toHaveLength(0);
    });
  },
);

describe.each(["en", "ar"] as const)("a platform that takes a pasted webhook address (%s)", (locale) => {
  const webhook = { auth_kind: "webhook_url", secret_kind: "webhook_url" };

  it("hides the address as a password, reads it left to right, and connects at once", async () => {
    const assign = spyAssign();
    const { stub } = await open(webhook, {}, locale);
    expect(field("secret-field").getAttribute("dir")).toBe("ltr");
    expect(field("secret-field").getAttribute("type")).toBe("password");
    await submit("secret-field", "secret-continue", "https://hooks.example.test/api/webhooks/1/token");
    expect(bodyOf(posts(stub, "/secret")[0])).toEqual({
      secret: "https://hooks.example.test/api/webhooks/1/token",
    });
    expect(assign).toHaveBeenCalledWith(RESULT);
  });

  it.each([
    ["host_not_allowed", "unprocessable_content", 422],
    ["secret_refused", "unprocessable_content", 422],
    ["provider_unreachable", "service_unavailable", 503],
    ["conflict", "conflict", 409],
  ])("shows its own words for %s and never the server's message", async (reason, code, status) => {
    const answer = refusal(code, status, reason === "conflict" ? undefined : { reason });
    const { host } = await open(webhook, { connectSecret: () => answer.clone() }, locale);
    await submit("secret-field", "secret-continue", "https://hooks.example.test/x");
    expect(byId("secret-error")?.dataset.reason).toBe(reason);
    expect(host.textContent).not.toContain("words the user must never see");
  });
});

const bot = { auth_kind: "bot_token", secret_kind: "bot_token" };
const statusOf =
  (state: string, chat: string | null = null, reason: string | null = null) =>
  () =>
    json({ data: { state, chat_title: chat, reason } });
const tick = async () => {
  act(() => void vi.advanceTimersByTime(2000));
  await settle();
};

async function waitFor(locale: "en" | "ar", api: Api = {}) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  return open(bot, { connectSecret: () => challengeAnswer("abcd234xyz"), ...api }, locale);
}

describe.each(["en", "ar"] as const)(
  "a platform whose bot waits for a word typed into a chat (%s)",
  (locale) => {
    const wait = (api: Api = {}) => waitFor(locale, api);

    it("shows the word to type, reads the status every 2 seconds, and offers Connect once a chat answered", async () => {
      let state = "waiting";
      const { stub } = await wait({
        challengeStatus: () => statusOf(state, state === "matched" ? "Team chat" : null)(),
      });
      await submit("secret-field", "secret-continue", "123456:bot-token-value");
      expect(byId("challenge-word")?.textContent).toBe("abcd234xyz");
      expect(byId("challenge-word")?.closest("bdi")?.getAttribute("dir")).toBe("ltr");
      expect(byId("challenge-complete")).toBeNull();
      await tick();
      await tick();
      expect(callsTo(stub, "GET", `/challenge/${CHALLENGE_ID}`)).toHaveLength(2);
      state = "matched";
      await tick();
      expect(byId("challenge-status")?.dataset.state).toBe("matched");
      expect(byId("challenge-chat")?.textContent).toBe("Team chat");
      await tick();
      expect(callsTo(stub, "GET", `/challenge/${CHALLENGE_ID}`)).toHaveLength(3);
    });

    it("completes with the word and goes to the result", async () => {
      const assign = spyAssign();
      const { stub } = await wait({ challengeStatus: statusOf("matched", "Team chat") });
      await submit("secret-field", "secret-continue", "123456:bot-token-value");
      await tick();
      click(byId("challenge-complete") as HTMLElement);
      await settle();
      expect(bodyOf(posts(stub, "/complete")[0])).toEqual({ word: "abcd234xyz" });
      expect(assign).toHaveBeenCalledWith(RESULT);
    });

    it("offers a new word once the old one expired, and shows the one renew answers without asking for the token again", async () => {
      const { stub } = await wait({ challengeStatus: statusOf("expired") });
      await submit("secret-field", "secret-continue", "123456:bot-token-value");
      await tick();
      expect(byId("challenge-status")?.dataset.state).toBe("expired");
      click(byId("challenge-renew") as HTMLElement);
      await settle();
      expect(posts(stub, "/renew")).toHaveLength(1);
      expect(posts(stub, "/secret")).toHaveLength(1);
      expect(byId("challenge-word")?.textContent).toBe("newword234");
    });
  },
);

describe.each(["en", "ar"] as const)("a challenge that cannot be read on (%s)", (locale) => {
  const wait = (api: Api = {}) => waitFor(locale, api);

  it("sends a session that ended to sign-in and reads the status no more", async () => {
    const { stub, router } = await wait({ challengeStatus: () => refusal("unauthenticated", 401) });
    await submit("secret-field", "secret-continue", "123456:bot-token-value");
    await tick();
    expect(router.state.location.pathname).toBe("/sign-in");
    await tick();
    expect(callsTo(stub, "GET", `/challenge/${CHALLENGE_ID}`)).toHaveLength(1);
  });

  it.each([
    ["forbidden", 403],
    ["not_found", 404],
  ])(
    "says in fixed words that the challenge is gone on %s and reads the status no more",
    async (code, status) => {
      const { stub, host } = await wait({ challengeStatus: () => refusal(code, status) });
      await submit("secret-field", "secret-continue", "123456:bot-token-value");
      await tick();
      expect(byId("challenge-gone")?.getAttribute("role")).toBe("alert");
      expect(host.textContent).not.toContain("words the user must never see");
      await tick();
      expect(callsTo(stub, "GET", `/challenge/${CHALLENGE_ID}`)).toHaveLength(1);
    },
  );
});

describe.each(["en", "ar"] as const)("a challenge that has ended (%s)", (locale) => {
  const wait = (api: Api = {}) => waitFor(locale, api);

  it("says a newer word replaced this one, and offers neither Renew nor Connect", async () => {
    await wait({ challengeStatus: statusOf("ended") });
    await submit("secret-field", "secret-continue", "123456:bot-token-value");
    await tick();
    expect(byId("challenge-status")?.dataset.state).toBe("ended");
    expect(byId("challenge-renew")).toBeNull();
    expect(byId("challenge-complete")).toBeNull();
  });

  it.each([
    ["complete", "challenge-complete", "matched"],
    ["renew", "challenge-renew", "expired"],
  ])("hides Renew and Connect once %s says the challenge is gone", async (_call, button, state) => {
    await wait({
      challengeStatus: statusOf(state, "Team chat"),
      challengeComplete: () => refusal("not_found", 404),
      challengeRenew: () => refusal("not_found", 404),
    });
    await submit("secret-field", "secret-continue", "123456:bot-token-value");
    await tick();
    click(byId(button) as HTMLElement);
    await settle();
    expect(byId("challenge-gone")?.getAttribute("role")).toBe("alert");
    expect(byId("challenge-complete")).toBeNull();
    expect(byId("challenge-renew")).toBeNull();
    expect(byId("challenge-error")).toBeNull();
  });
});

describe.each(["en", "ar"] as const)("a word held because the bot cannot post (%s)", (locale) => {
  it("says so while the word stays shown, and drops the text once a chat is found", async () => {
    let reason: string | null = "bot_cannot_post";
    await waitFor(locale, {
      challengeStatus: () =>
        statusOf(reason === null ? "matched" : "waiting", reason === null ? "Team chat" : null, reason)(),
    });
    await submit("secret-field", "secret-continue", "123456:bot-token-value");
    await tick();
    const held = byId("challenge-held");
    expect(held?.getAttribute("role")).toBe("status");
    expect(held?.textContent).toMatch(
      locale === "en" ? /then send the same word again/i : /الكلمة نفسها مرة أخرى/,
    );
    expect(byId("challenge-renew")).toBeNull();
    expect(byId("challenge-word")?.textContent).toBe("abcd234xyz");
    reason = null;
    await tick();
    expect(byId("challenge-held")).toBeNull();
    expect(byId("challenge-status")?.dataset.state).toBe("matched");
  });
});

describe.each(["en", "ar"] as const)("a challenge that is done (%s)", (locale) => {
  const wait = (api: Api = {}) => waitFor(locale, api);

  it("shows the success and the next action when the challenge is done elsewhere", async () => {
    const assign = spyAssign();
    let connected = false;
    const { host } = await wait({
      challengeStatus: () => {
        connected = true;
        return statusOf("done")();
      },
      channelList: () =>
        channelPage(
          connected
            ? [channelRow(), channelRow({ id: SECRET_CHANNEL, display_name: "Team chat channel" })]
            : [channelRow()],
          null,
          ["connect"],
        ),
    });
    await submit("secret-field", "secret-continue", "123456:bot-token-value");
    await tick();
    expect(byId("challenge-status")?.dataset.state).toBe("done");
    expect(host.textContent).not.toContain("Team chat channel");
    click(byId("challenge-next") as HTMLElement);
    await settle();
    expect(host.textContent).toContain("Team chat channel");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe.each(["en", "ar"] as const)("reconnecting a channel that holds a pasted secret (%s)", (locale) => {
  it.each([
    ["bot_token", "bot_token"],
    ["webhook_url", "webhook_url"],
  ])("goes to the %s step with the channel and never to the authorization", async (kind, authKind) => {
    const stub = stubApi({
      workspaces: uuidWorkspaces(),
      channelList: () =>
        channelPage([channelRow({ provider_id: "step_net", actions: ["reconnect"] })], null, ["connect"]),
      providers: () => json({ data: [provider({ auth_kind: authKind, secret_kind: kind })] }),
    });
    const { host } = await openApp(PATH, locale);
    await settle();
    click(host.querySelector<HTMLElement>('[data-testid="card-reconnect"]') as HTMLElement);
    await settle();
    expect(posts(stub, "/start")).toHaveLength(0);
    await submit("secret-field", "secret-continue", "https://hooks.example.test/x");
    expect(bodyOf(posts(stub, "/secret")[0])).toMatchObject({ channel_id: expect.any(String) });
  });
});
