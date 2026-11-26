import { REJECT_REASONS } from "@shoutory/core/media";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Api,
  CONNECT_WS,
  channelPage,
  channelRow,
  click,
  closeApp,
  json,
  mediaPage,
  mediaRow,
  openApp,
  refusal,
  settle,
  stubApi,
  uuidWorkspaces,
} from "../../../test/support/app";
import { setZone } from "../../account/prefs";

afterEach(closeApp);

const ID = "0190a000-0000-7000-8000-00000000f001";
const PATH = `/w/${CONNECT_WS}/media/${ID}`;
const ARABIC = /[؀-ۿ]/;
const channelId = (n: number) => `0190a000-0000-7000-8000-0000000000d${n}`;

const all = (host: ParentNode, id: string) => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const byId = (host: ParentNode, id: string) => all(host, id)[0] ?? null;
const text = (host: ParentNode, id: string) => byId(host, id)?.textContent ?? "";
const pageState = (host: ParentNode) => byId(host, "media-detail-state")?.dataset.state;

const medium = (change: Record<string, unknown> = {}) =>
  json({ data: { ...mediaRow({ id: ID }), post_count: 0, ...change } });
const fitRow = (n: number, change: Record<string, unknown> = {}) => ({
  channel_id: channelId(n),
  ok: true,
  ...change,
});

async function visit(api: Api = {}, locale: "en" | "ar" = "en") {
  const stub = stubApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(PATH, locale);
  await settle();
  return { stub, ...opened };
}
const calls = (stub: ReturnType<typeof stubApi>, ending: string) =>
  stub.mock.calls
    .map(([url]) => new URL(url, "http://same-origin.invalid"))
    .filter((url) => url.pathname.endsWith(ending));
function deferred() {
  let release: (answer: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

describe("one media file", () => {
  it.each([
    ["pending_upload", null],
    ["uploaded", null],
    ["scanning", null],
    ["processing", null],
    ["ready", null],
    ["rejected", "infected"],
    ["quarantined", null],
  ])(
    "a %s file shows its state word, never the code, and asks for fit only when ready",
    async (state, reason) => {
      const { host, stub } = await visit({ medium: () => medium({ state, reject_reason: reason }) });
      expect(pageState(host)).toBe("ready");
      expect(byId(host, "detail-state")?.dataset.state).toBe(state === "quarantined" ? "unknown" : state);
      expect(text(host, "detail-state")).not.toContain(state);
      expect(byId(host, "detail-reason")?.dataset.reason).toBe(reason ?? undefined);
      expect(calls(stub, "/fit")).toHaveLength(state === "ready" ? 1 : 0);
    },
  );

  it.each<[string, Record<string, unknown>, "thumb" | "image" | "video"]>([
    ["a ready image", {}, "thumb"],
    ["an image named .MP4", { file_name: "clip.MP4" }, "thumb"],
    ["an image whose thumbnail is pending", { derivatives: { thumb: "pending" } }, "image"],
    ["a video named .png", { mime: "video/mp4", file_name: "clip.png", duration_ms: 4000 }, "video"],
  ])("%s gets its preview from the stored type, never the name", async (_name, change, look) => {
    const { host } = await visit({ medium: () => medium(change) });
    const thumb = byId(host, "detail-thumb") as HTMLImageElement | null;
    expect(thumb?.getAttribute("src") ?? null).toBe(
      look === "thumb" ? `/api/v1/workspaces/${CONNECT_WS}/media/${ID}/derivatives/thumb` : null,
    );
    expect(byId(host, "detail-icon")?.dataset.kind ?? null).toBe(look === "thumb" ? null : look);
  });

  it("an image whose thumbnail fails to load falls back to the icon", async () => {
    const { host } = await visit();
    act(() => {
      byId(host, "detail-thumb")?.dispatchEvent(new Event("error"));
    });
    expect(byId(host, "detail-thumb")).toBeNull();
    expect(byId(host, "detail-icon")?.dataset.kind).toBe("image");
  });
});

describe("the facts of one media file", () => {
  it("shows size, dimensions and the zone of its date; duration only for a video", async () => {
    setZone("UTC");
    const { host } = await visit({ medium: () => medium() });
    expect(text(host, "fact-dimensions")).toMatch(/640.*480/);
    expect(byId(host, "fact-duration")).toBeNull();
    expect(byId(host, "fact-created")?.querySelector("time")?.textContent).toContain("UTC");
    closeApp();
    const video = await visit({ medium: () => medium({ mime: "video/mp4", duration_ms: 65000 }) }, "ar");
    expect(text(video.host, "fact-duration")).toMatch(ARABIC);
  });

  it("says how many posts use it, with every Arabic plural form", async () => {
    const said: string[] = [];
    for (const count of [0, 1, 2, 3, 11, 100]) {
      const { host } = await visit({ medium: () => medium({ post_count: count }) }, "ar");
      said.push(text(host, "fact-posts"));
      closeApp();
    }
    expect(said.every((words) => ARABIC.test(words))).toBe(true);
    expect(new Set(said.map((words) => words.replace(/\d+/g, "#"))).size).toBe(6);
  });

  it.each([
    ["thumb", "ready"],
    ["stripped", "pending"],
    ["stripped", "failed"],
    ["poster_frame", "ready"],
    ["thumb", "melting"],
  ])("the %s copy in state %s has words in both languages", async (profile, state) => {
    for (const locale of ["en", "ar"] as const) {
      const { host } = await visit({ medium: () => medium({ derivatives: { [profile]: state } }) }, locale);
      const row = byId(host, "derivative");
      expect(row?.dataset.profile).toBe(profile);
      expect(row?.textContent).not.toMatch(new RegExp(`${profile}|${state}`));
      expect(ARABIC.test(row?.textContent ?? "")).toBe(locale === "ar");
      closeApp();
    }
  });

  it("a slow read shows a placeholder after 300 ms, not before", async () => {
    const { host } = await visit({ medium: deferred().answer });
    expect(pageState(host)).toBe("loading");
    expect(byId(host, "media-detail-skeleton")).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(byId(host, "media-detail-skeleton")).not.toBeNull();
  });
});

describe("the size of one media file", () => {
  it.each([
    [512, "512 byte"],
    [2048, "2 kB"],
    [999_999, "1 MB"],
    [1_500_000, "1.5 MB"],
    [2_000_000_000, "2 GB"],
  ])("%d bytes read %s", async (bytes, words) => {
    const { host } = await visit({ medium: () => medium({ byte_size: bytes }) });
    expect(byId(host, "fact-size")?.querySelector("dd")?.textContent).toBe(words);
  });
});

describe("refusals of the detail read", () => {
  it("a 404 (unknown, other workspace or deleted) shows the not-found page", async () => {
    const { host } = await visit({ medium: () => refusal("not_found", 404) });
    expect(byId(host, "not-found")).not.toBeNull();
  });

  it("a 403 shows the no-access page and a 401 goes to sign-in", async () => {
    const { host } = await visit({ medium: () => refusal("forbidden", 403) });
    expect(byId(host, "forbidden")).not.toBeNull();
    closeApp();
    const { router } = await visit({ medium: () => refusal("unauthenticated", 401) });
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("a failed read names its request id, never the server's text, and Try again reads again", async () => {
    let failing = true;
    const { host } = await visit({ medium: () => (failing ? refusal("internal_error", 500) : medium()) });
    expect(pageState(host)).toBe("failed");
    expect(host.textContent).toContain("req-42");
    expect(host.textContent).not.toContain("words the user must never see");
    failing = false;
    click(byId(host, "media-detail-retry") as HTMLElement);
    await settle();
    expect(pageState(host)).toBe("ready");
  });
});

const fits = (...rows: unknown[]): Api => ({ mediaFit: () => mediaPage(rows) });

describe("where the file fits", () => {
  it.each([...REJECT_REASONS, "provider_unavailable", "capability_missing", "brand_new_reason"])(
    "a channel refused for %s gets words in both languages, never the code",
    async (reason) => {
      for (const locale of ["en", "ar"] as const) {
        const { host } = await visit(fits(fitRow(1, { ok: false, reason })), locale);
        const row = byId(host, "fit-row");
        expect(row?.dataset.ok).toBe("false");
        expect(row?.textContent).not.toContain(reason);
        expect(ARABIC.test(row?.textContent ?? "")).toBe(locale === "ar");
        closeApp();
      }
    },
  );
});

describe("the channels a file fits", () => {
  it.each<[string, Api, string[]]>([
    ["the channels read is refused", { channelList: () => refusal("forbidden", 403) }, ["1", "2"]],
    ["the channels read fails", { channelList: () => refusal("internal_error", 500) }, ["1", "2"]],
    [
      "one channel is not on the channels page",
      { channelList: () => channelPage([channelRow({ id: channelId(1), display_name: "Acme Page" })]) },
      ["Acme Page", "2"],
    ],
  ])("when %s, rows show names or ordinals and never an id", async (_name, api, labels) => {
    const { host } = await visit({
      ...api,
      ...fits(fitRow(1), fitRow(2, { ok: false, reason: "too_large" })),
    });
    const rows = all(host, "fit-row");
    labels.forEach((label, index) => {
      expect(rows[index]?.textContent).toContain(label);
    });
    expect(host.textContent).not.toMatch(/0190a000-0000-7000-8000-0000000000d/);
    expect(text(host, "fit-summary")).toMatch(/1.*2/);
  });

  it("Show more appends the next page, and the summary waits for the last page", async () => {
    const { host, stub } = await visit({
      mediaFit: (query) =>
        query.has("cursor") ? mediaPage([fitRow(2)]) : mediaPage([fitRow(1)], channelId(1)),
    });
    expect(byId(host, "fit-summary")).toBeNull();
    click(byId(host, "fit-more") as HTMLElement);
    await settle();
    expect(calls(stub, "/fit").at(-1)?.searchParams.get("cursor")).toBe(channelId(1));
    expect(all(host, "fit-row")).toHaveLength(2);
    expect(byId(host, "fit-more")).toBeNull();
    expect(text(host, "fit-summary")).toMatch(/2.*2/);
  });
});

describe("refusals and races of the fit read", () => {
  it("a next page asked for before the fit was read again never joins the new rows", async () => {
    const late = deferred();
    let failFirst = true;
    const { host } = await visit({
      mediaFit: (query) => {
        if (query.has("cursor")) return late.answer();
        return mediaPage([fitRow(failFirst ? 1 : 3)], channelId(1));
      },
    });
    click(byId(host, "fit-more") as HTMLElement);
    failFirst = false;
    click(byId(host, "fit-reload") as HTMLElement);
    await settle();
    late.release(mediaPage([fitRow(2)]));
    await settle();
    expect(all(host, "fit-row").map((row) => row.dataset.channel)).toEqual([channelId(3)]);
  });

  it("a failed fit read keeps the page with a notice, and Try again reads it again", async () => {
    let failing = true;
    const { host } = await visit({
      mediaFit: () => (failing ? refusal("internal_error", 500) : mediaPage([fitRow(1)])),
    });
    expect(pageState(host)).toBe("ready");
    expect(byId(host, "fit-error")).not.toBeNull();
    failing = false;
    click(byId(host, "fit-reload") as HTMLElement);
    await settle();
    expect(all(host, "fit-row")).toHaveLength(1);
  });

  it("a fit 409 reads the file again; a fit 404 shows the not-found page", async () => {
    let state = "ready";
    const { host, stub } = await visit({
      medium: () => medium({ state }),
      mediaFit: () => {
        state = "processing";
        return refusal("conflict", 409, { reason: "not_ready" });
      },
    });
    expect(calls(stub, `/media/${ID}`)).toHaveLength(2);
    expect(byId(host, "detail-state")?.dataset.state).toBe("processing");
    closeApp();
    const gone = await visit({ mediaFit: () => refusal("not_found", 404) });
    expect(byId(gone.host, "not-found")).not.toBeNull();
  });

  it.each<[string, () => Response, string]>([
    ["409 reads the file again", () => refusal("conflict", 409, { reason: "not_ready" }), "reread"],
    ["401 goes to sign-in", () => refusal("unauthenticated", 401), "sign-in"],
  ])("a later fit page answering %s, as the first page does", async (_name, later, outcome) => {
    const { host, stub, router } = await visit({
      mediaFit: (query) => (query.has("cursor") ? later() : mediaPage([fitRow(1)], channelId(1))),
    });
    click(byId(host, "fit-more") as HTMLElement);
    await settle();
    if (outcome === "reread") expect(calls(stub, `/media/${ID}`)).toHaveLength(2);
    else expect(router.state.location.pathname).toBe("/sign-in");
  });
});

describe("moving between the library and a file", () => {
  it("a tile's name opens the file, and Back to the library returns", async () => {
    stubApi({ workspaces: uuidWorkspaces(), mediaList: () => mediaPage([mediaRow({ id: ID })]) });
    const { host, router } = await openApp(`/w/${CONNECT_WS}/media`);
    await settle();
    click(byId(host, "tile-link") as HTMLElement);
    await settle();
    expect(router.state.location.pathname).toBe(PATH);
    click(byId(host, "media-detail-back") as HTMLElement);
    await settle();
    expect(router.state.location.pathname).toBe(`/w/${CONNECT_WS}/media`);
  });
});
