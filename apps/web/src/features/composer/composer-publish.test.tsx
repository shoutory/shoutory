import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelPage, click, closeApp, json, openApp, refusal, settle } from "../../../test/support/app";
import {
  allById,
  BROKEN,
  byId,
  type Call,
  CH,
  CHANNELS,
  callsOf,
  detailOf,
  POST,
  stubComposerApi,
  typeInto,
  VERSION_2,
  variantRow,
} from "../../../test/support/composer-api";

afterEach(() => {
  vi.restoreAllMocks();
  closeApp();
});

const VARIANT = "0190a000-0000-7000-8000-00000000e001";
const SENT = { post_id: POST, variant_ids: [VARIANT] };
const SCHEDULED = {
  ...SENT,
  local_due: "2026-12-01T11:00",
  due_tz: "Africa/Cairo",
  due_at: "2026-12-01T09:00:00.000Z",
};

interface Setup {
  detail?: () => Response;
  schedule?: (call: Call) => Response | Promise<Response>;
  publish?: (call: Call) => Response | Promise<Response>;
  unschedule?: (call: Call) => Response | Promise<Response>;
  patch?: (call: Call) => Response;
  channels?: unknown[];
}

async function open(setup: Setup = {}) {
  const detail = setup.detail ?? (() => detailOf([variantRow(CH.short, "Short words")]));
  const stub = stubComposerApi({
    channelList: () => channelPage(setup.channels ?? CHANNELS, null, []),
    answer: (call) => {
      if (call.method === "GET" && call.path === `posts/${POST}`) return detail();
      if (call.path === `posts/${POST}/schedule`) return setup.schedule?.(call) ?? json({ data: SCHEDULED });
      if (call.path === `posts/${POST}/publish`) return setup.publish?.(call) ?? json({ data: SENT });
      if (call.path === `posts/${POST}/unschedule`) return setup.unschedule?.(call) ?? json({ data: SENT });
      if (call.method === "PATCH") return setup.patch?.(call);
      return undefined;
    },
  });
  const opened = await openApp(`/w/w1/posts/${POST}/edit`);
  await settle();
  return { stub, ...opened };
}

const when = (value: string) => {
  typeInto(byId("schedule-when") as HTMLInputElement, value);
  return settle();
};
const press = async (id: string) => {
  await click(byId(id) as HTMLElement);
  await settle();
};
const disabled = (id: string) => byId(id)?.getAttribute("aria-disabled") === "true";
const reasonOf = (id: string) =>
  document.getElementById(byId(id)?.getAttribute("aria-describedby") ?? "")?.textContent ?? "";

describe("scheduling in the workspace zone", () => {
  it("names the zone, sends the wall time with a key, says when it is scheduled and goes to the post", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub, router } = await open();
    expect(document.body.textContent).toContain("Time zone: Cairo");
    await when("2026-12-01T11:00");
    expect(document.body.textContent).not.toContain("Scheduled for");
    await press("schedule-submit");
    const [call] = callsOf(stub, "POST", `/posts/${POST}/schedule`);
    expect(call?.body).toEqual({ local_due: "2026-12-01T11:00", variant_ids: [VARIANT] });
    expect(call?.headers["Idempotency-Key"]).toBeTruthy();
    expect(byId("schedule-done")?.textContent).toContain("Scheduled for");
    expect(byId("schedule-done")?.textContent).toContain("Cairo");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(router.state.location.pathname).toBe(`/w/w1/posts/${POST}`);
  });

  it("a time that has passed says so and sends nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
    const { stub } = await open();
    await when("2026-11-28T11:00");
    await press("schedule-submit");
    expect(byId("schedule-problem")?.textContent).toContain("That time has passed");
    expect(callsOf(stub, "POST", "/schedule")).toHaveLength(0);
  });

  it("text over the limit keeps scheduling and publishing unavailable, with the reason", async () => {
    await open({ detail: () => detailOf([variantRow(CH.short, "x".repeat(32))]) });
    await when("2026-12-01T11:00");
    expect(disabled("schedule-submit")).toBe(true);
    expect(disabled("publish-now")).toBe(true);
    expect(reasonOf("schedule-submit")).toContain("Fix");
  });

  it("a channel that needs reconnecting cannot be scheduled even though the draft keeps it", async () => {
    await open({
      channels: [...CHANNELS, BROKEN],
      detail: () => detailOf([variantRow(BROKEN.id, "Short words")]),
    });
    await when("2026-12-01T11:00");
    expect(disabled("schedule-submit")).toBe(true);
    expect(reasonOf("schedule-submit")).toContain("Reconnect needed");
  });
});

const issues = [{ variant: 0, key: "text", reason: "too_long" }];
const withLists = (details: Record<string, unknown>, status: number, code: string) =>
  json({ error: { code, message: "words the user must never see", requestId: "req-42", details } }, status);

describe("what the server refuses", () => {
  it.each<[string, () => Response, string, string]>([
    [
      "a time that does not exist",
      () => refusal("unprocessable_content", 422, { reason: "local_time_nonexistent" }),
      "schedule-problem",
      "This time does not exist on",
    ],
    [
      "a channel that is not connected",
      () => refusal("conflict", 409, { reason: "channel_not_connected" }),
      "schedule-failure",
      "needs to be reconnected",
    ],
    [
      "a file that cannot be used",
      () => refusal("unprocessable_content", 422, { reason: "media_unavailable" }),
      "schedule-failure",
      "A file cannot be used",
    ],
    [
      "a post that is already live",
      () => withLists({ reason: "use_edit", actions: ["edit", "duplicate"] }, 409, "conflict"),
      "schedule-failure",
      "Duplicate to draft",
    ],
  ])("%s is explained and nothing is said to be scheduled", async (_name, answer, where, words) => {
    await open({ schedule: answer });
    await when("2026-12-01T11:00");
    await press("schedule-submit");
    expect(byId(where)?.textContent).toContain(words);
    expect(document.body.textContent).not.toContain("Scheduled for");
  });
});

describe("a time that needs a choice, and a strict answer", () => {
  it("a time that happens twice asks earlier or later and sends the choice", async () => {
    let first = true;
    const { stub } = await open({
      schedule: () => {
        const answer = first
          ? refusal("unprocessable_content", 422, { reason: "local_time_ambiguous" })
          : json({ data: SCHEDULED });
        first = false;
        return answer;
      },
    });
    await when("2026-12-01T11:00");
    await press("schedule-submit");
    await click(byId("fold-later") as HTMLElement);
    await settle();
    await press("schedule-submit");
    const calls = callsOf(stub, "POST", "/schedule");
    expect(calls[1]?.body).toEqual({ local_due: "2026-12-01T11:00", variant_ids: [VARIANT], fold: "later" });
  });

  it("the strict answer for a variant shows under the text of that channel", async () => {
    await open({
      schedule: () => withLists({ reason: "variant_invalid", issues }, 422, "unprocessable_content"),
    });
    await when("2026-12-01T11:00");
    await press("schedule-submit");
    await click(allById("tab-channel")[0] as HTMLElement);
    await settle();
    expect(document.body.textContent).toContain("The text is too long for Short One");
  });
});

describe("pressing the buttons", () => {
  it("a second press while the first is working sends one request", async () => {
    let release: (answer: Response) => void = () => undefined;
    const { stub } = await open({ schedule: () => new Promise<Response>((done) => (release = done)) });
    await when("2026-12-01T11:00");
    const button = byId("schedule-submit") as HTMLElement;
    await click(button);
    await click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => release(json({ data: SCHEDULED })));
    expect(callsOf(stub, "POST", "/schedule")).toHaveLength(1);
  });

  it("a retry after a lost answer keeps its key and a new press gets a new one", async () => {
    let tries = 0;
    const { stub } = await open({
      schedule: () => {
        tries += 1;
        return tries === 1
          ? Promise.reject(new TypeError("network"))
          : refusal("conflict", 409, { reason: "post_in_flight" });
      },
    });
    await when("2026-12-01T11:00");
    await press("schedule-submit");
    await press("schedule-submit");
    await press("schedule-submit");
    const keys = callsOf(stub, "POST", "/schedule").map((call) => call.headers["Idempotency-Key"]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });
});

describe("publish now and the Undo", () => {
  async function published() {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const opened = await open();
    await press("publish-now");
    return opened;
  }
  const after = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("says it went to the queue, never Published, and offers an Undo that says when it ends", async () => {
    const { stub } = await published();
    expect(callsOf(stub, "POST", `/posts/${POST}/publish`)[0]?.body).toEqual({ variant_ids: [VARIANT] });
    expect(byId("publish-sent")?.textContent).toContain("Sent to the queue");
    expect(document.body.textContent).not.toContain("Published");
    expect(byId("publish-undo")?.textContent).toContain("Undo (ends in 6 s)");
    await after(2000);
    expect(byId("publish-undo")?.textContent).toContain("Undo (ends in 4 s)");
  });

  it("Undo takes the post back out of the queue", async () => {
    const { stub, router } = await published();
    await press("publish-undo");
    expect(callsOf(stub, "POST", "/unschedule")[0]?.body).toEqual({ variant_ids: [VARIANT] });
    expect(byId("publish-undo")).toBeNull();
    expect(router.state.location.pathname).toBe(`/w/w1/posts/${POST}/edit`);
  });

  it("after six seconds the Undo is gone and the post's page opens", async () => {
    const { router } = await published();
    await after(6000);
    expect(byId("publish-undo")).toBeNull();
    expect(router.state.location.pathname).toBe(`/w/w1/posts/${POST}`);
  });
});

describe("a change to a scheduled post", () => {
  it("is saved first and then offered as Update schedule for just that variant, keeping the time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub } = await open({
      detail: () =>
        detailOf([variantRow(CH.short, "Short words")], ["schedule", "publish_now", "unschedule"], {
          schedule_state: "scheduled",
          due_at: "2026-12-01T09:00:00.000Z",
          due_tz: "Africa/Cairo",
        }),
      patch: () => json({ data: { id: POST, version_id: VERSION_2, pending_changes: [VARIANT] } }),
    });
    typeInto(document.querySelector('[data-testid="composer-base"]') as HTMLTextAreaElement, "Changed words");
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(byId("schedule-submit")?.textContent).toContain("Update schedule");
    await click(byId("schedule-submit") as HTMLElement);
    await settle();
    const [call] = callsOf(stub, "POST", "/schedule");
    expect(call?.body).toEqual({ local_due: "2026-12-01T11:00", variant_ids: [VARIANT] });
  });
});
