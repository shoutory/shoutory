import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { byText, click, closeApp, json, openApp, refusal, stubApi } from "../../test/support/app";

afterEach(closeApp);

const TOKEN = `invitetoken${"a".repeat(32)}`;
const PATH = `/invite/${TOKEN}`;
const JOINED = "0190a000-0000-7000-8000-000000000002";
const ASK = "Ask the person who invited you for a new invitation.";
const settle = () => act(async () => undefined);
const refused = (code: string, status: number, details?: Record<string, string>) =>
  json({ error: { code, message: "words the user must never see", details, requestId: "req-42" } }, status);
const signedOut = { session: () => refusal("unauthenticated", 401) };
const callsTo = (stub: ReturnType<typeof stubApi>, name: string) =>
  stub.mock.calls.filter(([path]) => path.includes(name));
const accept = (host: ParentNode) => byText(host, "button", "Accept invitation");

describe("the invitation page (security floor)", () => {
  it("opens with no accept call, sends the token only in the body of one POST on press, and joins the workspace", async () => {
    const stub = stubApi({ acceptInvitation: () => json({ data: { workspace_id: JOINED } }) });
    const { host, router } = await openApp(PATH);
    expect(callsTo(stub, "invitations/accept")).toHaveLength(0);
    expect(document.title).not.toContain(TOKEN);
    expect([...host.querySelectorAll("a")].every((link) => !link.href.includes(TOKEN))).toBe(true);
    click(accept(host));
    await settle();
    const [path, init] = callsTo(stub, "invitations/accept")[0] ?? [];
    expect(callsTo(stub, "invitations/accept")).toHaveLength(1);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ token: TOKEN });
    expect(path).not.toContain(TOKEN);
    expect(router.state.location.pathname).toBe(`/w/${JOINED}`);
  });

  it("signed out it opens without a redirect: sign in carries the page, create account carries nothing", async () => {
    const stub = stubApi(signedOut);
    const { host, router } = await openApp(PATH);
    expect(router.state.location.pathname).toBe(PATH);
    expect(callsTo(stub, "invitations/accept")).toHaveLength(0);
    const signIn = byText<HTMLAnchorElement>(host, "a", "Sign in");
    expect(new URL(signIn.href, "http://x.invalid").searchParams.get("return-to")).toBe(PATH);
    expect(byText<HTMLAnchorElement>(host, "a", "Create account").getAttribute("href")).toBe("/sign-up");
    expect(host.textContent).toMatch(/open the invitation link again/i);
  });

  it.each(["short", "t".repeat(44)])(
    "the malformed token %j shows the unknown-link copy and calls nothing",
    async (bad) => {
      const stub = stubApi();
      const { host } = await openApp(`/invite/${bad}`);
      expect(host.textContent).toContain("We cannot find this invitation");
      expect(callsTo(stub, "invitations/accept")).toHaveLength(0);
    },
  );
});

const INVITER = "Someone Else";
const ended = (reason: string, extra: Record<string, string> = {}) =>
  refused("invitation_unusable", 410, { reason, ...extra });
const blocked = (reason: string) => refused("forbidden", 403, { reason });
// name, the answer, the words it must show, and whether it tells the person to ask for a new invitation.
const STATES: [string, Response, string, boolean][] = [
  ["expired", ended("expired", { invited_by: INVITER }), "This invitation has expired", true],
  ["used", ended("used"), "This invitation was already used", true],
  ["revoked", ended("revoked"), "This invitation was withdrawn", true],
  ["an unknown link", refused("not_found", 404), "We cannot find this invitation", true],
  [
    "already a member",
    refused("conflict", 409, { reason: "already_member" }),
    "You are already a member",
    false,
  ],
  ["an unconfirmed email", blocked("email_unverified"), "Confirm your email first", false],
  ["another email", blocked("email_mismatch"), "This invitation is for a different email", false],
  ["too many attempts", refused("too_many_requests", 429), "Try again in a few minutes", false],
];

describe("the invitation page states", () => {
  it.each(STATES)("%s has its own words", async (_name, answer, words, asksForNew) => {
    stubApi({ acceptInvitation: () => answer.clone() });
    const { host } = await openApp(PATH);
    click(accept(host));
    await settle();
    expect(host.textContent).toContain(words);
    expect(host.textContent?.includes(ASK)).toBe(asksForNew);
    expect(host.textContent).not.toContain(INVITER);
    expect(host.textContent).not.toContain("words the user must never see");
  });

  it("another email offers sign out, then sign in again with the page to return to", async () => {
    const stub = stubApi({
      acceptInvitation: () => refused("forbidden", 403, { reason: "email_mismatch" }),
    });
    const { host, router } = await openApp(PATH);
    click(accept(host));
    await settle();
    click(byText(host, "button", "Sign out"));
    await settle();
    expect(callsTo(stub, "sign-out")).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(new URLSearchParams(router.state.location.search).get("return-to")).toBe(PATH);
  });

  it("an unconfirmed email offers a new confirmation link for the signed-in address", async () => {
    const stub = stubApi({
      acceptInvitation: () => refused("forbidden", 403, { reason: "email_unverified" }),
    });
    const { host } = await openApp(PATH);
    click(accept(host));
    await settle();
    click(byText(host, "button", "Send a new link"));
    await settle();
    const [, init] = callsTo(stub, "send-verification-email")[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ email: "person@example.test" });
  });

  it("an ended session on the press sends the visitor to sign in with this page to return to", async () => {
    stubApi({ acceptInvitation: () => refusal("unauthenticated", 401) });
    const { host, router } = await openApp(PATH);
    click(accept(host));
    await settle();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(new URLSearchParams(router.state.location.search).get("return-to")).toBe(PATH);
  });

  it("a server failure keeps the button, and the next press asks again", async () => {
    const stub = stubApi({ acceptInvitation: () => refusal("service_unavailable", 503) });
    const { host } = await openApp(PATH);
    click(accept(host));
    await settle();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    click(accept(host));
    await settle();
    expect(callsTo(stub, "invitations/accept")).toHaveLength(2);
  });
});
