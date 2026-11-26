import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { byText, click, closeApp, json, openApp, refusal, SESSION, stubApi } from "../../test/support/app";

afterEach(closeApp);

const NOW = Date.parse("2026-11-26T10:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ending = (at: number) => ({
  data: { ...SESSION.data, session: { id: "s1", expiresAt: new Date(at).toISOString() } },
});
type Answer = number | (() => Response | Promise<Response>);

// The get-session calls are answered in order (the page's own read first); the last answer repeats.
async function openEnding(...answers: Answer[]) {
  vi.useFakeTimers({ now: NOW });
  let call = 0;
  const stub = stubApi({
    session: () => {
      const answer = answers[Math.min(call++, answers.length - 1)] ?? NOW;
      return typeof answer === "number" ? json(ending(answer)) : answer();
    },
  });
  const opened = await openApp("/w/w1");
  const reads = () => stub.mock.calls.filter(([path]) => String(path).includes("/api/auth/get-session"));
  const peeks = () => reads().map(([, init]) => new Headers(init?.headers).get("X-Shoutory-Session-Peek"));
  return { ...opened, reads, peeks };
}

const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const warning = () => document.querySelector('[role="alertdialog"]');

describe("the warning before the session ends", () => {
  it.each([
    ["another call already moved the end, so nothing shows", NOW + 7 * DAY, false],
    ["the end did not move, so the warning shows", NOW + 20 * MINUTE, true],
  ])("five minutes before the end the page peeks: %s", async (_name, peeked, shown) => {
    const { peeks } = await openEnding(NOW + 20 * MINUTE, peeked);
    await pass(15 * MINUTE - 1);
    expect(peeks()).toEqual([null]);
    await pass(1);
    expect(peeks()).toEqual([null, "1"]);
    expect(warning() !== null).toBe(shown);
  });

  it.each([
    ["a moved end closes the warning", NOW + 7 * DAY, false],
    ["an end still inside five minutes says it cannot be extended", NOW + 20 * MINUTE, true],
  ])("Stay signed in sends a plain read: %s", async (_name, after, capped) => {
    const { peeks } = await openEnding(NOW + 20 * MINUTE, NOW + 20 * MINUTE, after);
    await pass(15 * MINUTE);
    click(byText(document.body, "button", "Stay signed in"));
    await pass(0);
    expect(peeks()).toEqual([null, "1", null]);
    expect(warning() !== null).toBe(capped);
    if (capped) {
      const buttons = [...document.querySelectorAll('[role="alertdialog"] button')].map(
        (button) => button.textContent,
      );
      expect(buttons).not.toContain("Stay signed in");
      expect(byText(document.body, "a", "Sign in again").getAttribute("href")).toBe(
        "/sign-in?return-to=%2Fw%2Fw1",
      );
    }
  });
});

describe("the warning when an answer fails, is closed or the end is far", () => {
  it("a Stay signed in that fails keeps the warning open and says what happened", async () => {
    await openEnding(NOW + 20 * MINUTE, NOW + 20 * MINUTE, () => refusal("service_unavailable", 503));
    await pass(15 * MINUTE);
    click(byText(document.body, "button", "Stay signed in"));
    await pass(0);
    expect(warning()?.textContent).toContain("We could not keep you signed in");
  });

  it("Close dismisses the warning", async () => {
    await openEnding(NOW + 20 * MINUTE);
    await pass(15 * MINUTE);
    click(byText(document.body, "button", "Close"));
    await pass(0);
    expect(warning()).toBeNull();
  });

  it("an end weeks away does not fire early (a browser timer over about 24.8 days fires at once)", async () => {
    const { reads } = await openEnding(NOW + 40 * DAY);
    await pass(DAY + MINUTE);
    expect(reads()).toHaveLength(1);
    expect(warning()).toBeNull();
  });

  it("a peek that fails still warns with the known end", async () => {
    await openEnding(NOW + 20 * MINUTE, () => Promise.reject(new TypeError("Failed to fetch")));
    await pass(15 * MINUTE);
    expect(warning()).not.toBeNull();
  });

  it("a peek that finds the session ended goes to the session-ended page, back to the page open then", async () => {
    const { router } = await openEnding(NOW + 20 * MINUTE, () => refusal("unauthenticated", 401));
    await act(() => router.navigate("/account/profile"));
    await pass(15 * MINUTE);
    expect(router.state.location.pathname).toBe("/session-expired");
    expect(router.state.location.search).toBe("?return-to=%2Faccount%2Fprofile");
  });
});
