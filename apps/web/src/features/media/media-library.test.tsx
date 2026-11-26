import { REJECT_REASONS } from "@shoutory/core/media";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Api,
  CONNECT_WS,
  click,
  closeApp,
  json,
  mediaPage,
  mediaRow,
  openApp,
  press,
  refusal,
  settle,
  stubApi,
  type,
  uuidWorkspaces,
} from "../../../test/support/app";

afterEach(closeApp);

const PATH = `/w/${CONNECT_WS}/media`;
const idOf = (n: number) => `0190a000-0000-7000-8000-00000000f${String(n).padStart(3, "0")}`;
const row = (n: number, change: Record<string, unknown> = {}) =>
  mediaRow({ id: idOf(n), file_name: `photo-${n}.png`, ...change });

const all = (host: ParentNode, id: string) => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const byId = (host: ParentNode, id: string) => all(host, id)[0] ?? null;
const tiles = (host: ParentNode) => all(host, "media-tile");
const tile = (host: ParentNode, n: number) => tiles(host).find((one) => one.dataset.mediaId === idOf(n));
const part = (host: ParentNode, n: number, id: string) => {
  const found = tile(host, n);
  return found ? byId(found, id) : null;
};
const stateOf = (host: ParentNode) => byId(host, "media-state")?.dataset.state;

async function visit(api: Api = {}, locale: "en" | "ar" = "en") {
  const stub = stubApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(PATH, locale);
  await settle();
  return { stub, ...opened };
}
const listOf = (...rows: unknown[]): Api => ({ mediaList: () => mediaPage(rows) });
const listCalls = (stub: ReturnType<typeof stubApi>) =>
  stub.mock.calls
    .map(([url]) => new URL(url, "http://same-origin.invalid"))
    .filter((url) => url.pathname.endsWith("/media"));
function deferred() {
  let release: (answer: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

describe("the media library tiles", () => {
  it.each<[string, Record<string, unknown>, "thumb" | "image" | "video", string]>([
    ["a ready image with a ready thumbnail", {}, "thumb", "ready"],
    ["an image whose name ends in .MP4", { file_name: "clip.MP4" }, "thumb", "ready"],
    ["a ready image whose thumbnail is pending", { derivatives: { thumb: "pending" } }, "image", "ready"],
    ["a processing image", { state: "processing", derivatives: {} }, "image", "processing"],
    ["a scanning image", { state: "scanning", derivatives: {} }, "image", "scanning"],
    [
      "a rejected image",
      { state: "rejected", reject_reason: "corrupt", derivatives: {} },
      "image",
      "rejected",
    ],
    ["a ready video", { mime: "video/mp4", file_name: "clip.png", duration_ms: 4000 }, "video", "ready"],
  ])("%s", async (_name, change, look, state) => {
    const { host } = await visit(listOf(row(1, change)));
    expect(part(host, 1, "tile-name")?.textContent).toContain(String(change.file_name ?? "photo-1.png"));
    expect(part(host, 1, "tile-state")?.dataset.state).toBe(state);
    const thumb = part(host, 1, "tile-thumb") as HTMLImageElement | null;
    expect(thumb?.getAttribute("src") ?? null).toBe(
      look === "thumb" ? `/api/v1/workspaces/${CONNECT_WS}/media/${idOf(1)}/derivatives/thumb` : null,
    );
    expect(part(host, 1, "tile-icon")?.dataset.kind ?? null).toBe(look === "thumb" ? null : look);
  });

  it.each([
    ...REJECT_REASONS.map((reason) => ["rejected", reason] as const),
    ...(["pending_upload", "uploaded", "scanning", "processing", "ready"] as const).map(
      (state) => [state, null] as const,
    ),
  ])("%s %s has a word in English and in Arabic, never the code", async (state, reason) => {
    for (const [locale, script] of [
      ["en", /^[^؀-ۿ]+$/],
      ["ar", /[؀-ۿ]/],
    ] as const) {
      const { host } = await visit(listOf(row(1, { state, reject_reason: reason, derivatives: {} })), locale);
      const said = reason === null ? ["tile-state"] : ["tile-state", "tile-reason"];
      const texts = said.map((testId) => part(host, 1, testId)?.textContent ?? "");
      expect(texts.every((text) => script.test(text) && !text.includes(reason ?? state))).toBe(true);
      expect(part(host, 1, "tile-reason")?.dataset.reason).toBe(reason ?? undefined);
      closeApp();
    }
  });

  it("a state or a reason the page does not know shows the general words, never the code", async () => {
    const { host } = await visit(
      listOf(
        row(1, { state: "rejected", reject_reason: "brand_new_reason" }),
        row(2, { state: "quarantined" }),
      ),
    );
    expect(part(host, 1, "tile-reason")?.dataset.reason).toBe("unknown");
    expect(part(host, 2, "tile-state")?.dataset.state).toBe("unknown");
    expect(host.textContent).not.toMatch(/brand_new_reason|quarantined/);
  });
});

describe("the media library page", () => {
  it.each<[string, () => Api, string]>([
    ["loading", () => ({ mediaList: deferred().answer }), "loading"],
    ["first use, nothing uploaded yet", () => listOf(), "empty"],
    ["a failed read", () => ({ mediaList: () => refusal("internal_error", 500) }), "failed"],
    ["media", () => listOf(row(1), row(2)), "list"],
  ])("%s", async (_name, api, state) => {
    const { host } = await visit(api());
    expect(stateOf(host)).toBe(state);
    expect(byId(host, "media-heading")).not.toBeNull();
    expect(byId(host, "media-retry") !== null).toBe(state === "failed");
    expect(tiles(host)).toHaveLength(state === "list" ? 2 : 0);
    expect(host.querySelector('[data-kind="first-use"] button')).toBeNull();
    expect(host.textContent).not.toContain("words the user must never see");
  });

  it("a slow first read shows placeholder tiles after 300 ms, not before", async () => {
    const { host } = await visit({ mediaList: deferred().answer });
    expect(byId(host, "media-skeleton")).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(byId(host, "media-skeleton")).not.toBeNull();
  });

  it("a failed read names its request id and is read again by Try again", async () => {
    let failing = true;
    const { host } = await visit({
      mediaList: () => (failing ? refusal("internal_error", 500) : mediaPage([row(1)])),
    });
    expect(host.textContent).toContain("req-42");
    failing = false;
    click(byId(host, "media-retry") as HTMLElement);
    await settle();
    expect(tiles(host)).toHaveLength(1);
  });

  it("a 403 shows the no-access page and a 401 goes to sign-in", async () => {
    const { host } = await visit({ mediaList: () => refusal("forbidden", 403) });
    expect(byId(host, "forbidden")).not.toBeNull();
    closeApp();
    const { router } = await visit({ mediaList: () => refusal("unauthenticated", 401) });
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("the Media link in the navigation leads here", async () => {
    stubApi({ workspaces: uuidWorkspaces(), ...listOf(row(1)) });
    const { host, router } = await openApp(`/w/${CONNECT_WS}/channels`);
    await settle();
    const link = [...host.querySelectorAll<HTMLAnchorElement>("nav a")].find((one) =>
      one.getAttribute("href")?.endsWith("/media"),
    );
    click(link as HTMLElement);
    await settle();
    expect(router.state.location.pathname).toBe(PATH);
  });
});

describe("searching and filtering", () => {
  const filtered = (query: URLSearchParams) =>
    query.size === 0 || query.has("cursor") ? mediaPage([row(1), row(2)], idOf(2)) : mediaPage([]);

  it.each([
    ["media-search", "q"],
    ["media-tag-filter", "tag"],
  ])("the %s field sends %s from the first page; Clear filters reads all again", async (testId, key) => {
    const { host, stub } = await visit({ mediaList: filtered });
    const search = byId(host, testId) as HTMLInputElement;
    type(search, "beach");
    press(search, "Enter");
    await settle();
    expect(listCalls(stub).at(-1)?.searchParams.get(key)).toBe("beach");
    expect(listCalls(stub).at(-1)?.searchParams.has("cursor")).toBe(false);
    expect(stateOf(host)).toBe("filtered");
    click(host.querySelector('[data-kind="filtered-out"] button') as HTMLElement);
    await settle();
    expect(listCalls(stub).at(-1)?.search).toBe("");
    expect(tiles(host)).toHaveLength(2);
  });

  it.each<[string, string, string]>([
    ["media-type", "type", "video"],
    ["media-state-filter", "state", "rejected"],
  ])("the %s select sends %s", async (testId, key, value) => {
    const { host, stub } = await visit({ mediaList: filtered });
    click(byId(host, testId) as HTMLElement);
    click(byId(document.body, `${testId}-${value}`) as HTMLElement);
    await settle();
    expect(listCalls(stub).at(-1)?.searchParams.get(key)).toBe(value);
  });

  it("a tag on a tile filters by that tag, and pressing the active tag clears it", async () => {
    const { host, stub } = await visit({
      mediaList: (query) =>
        mediaPage(query.has("tag") ? [row(1, { tags: ["summer"] })] : [row(1, { tags: ["summer"] }), row(2)]),
    });
    click(part(host, 1, "tile-tag") as HTMLElement);
    await settle();
    expect(listCalls(stub).at(-1)?.searchParams.get("tag")).toBe("summer");
    expect(tiles(host)).toHaveLength(1);
    click(byId(host, "media-tag-active") as HTMLElement);
    await settle();
    expect(listCalls(stub).at(-1)?.searchParams.has("tag")).toBe(false);
    expect(tiles(host)).toHaveLength(2);
  });
});

describe("while filtering", () => {
  it("while a new filter loads, the old tiles stay with an Updating notice", async () => {
    const next = deferred();
    let first = true;
    const { host } = await visit({
      mediaList: () => {
        if (!first) return next.answer();
        first = false;
        return mediaPage([row(1)]);
      },
    });
    const search = byId(host, "media-search") as HTMLInputElement;
    type(search, "beach");
    press(search, "Enter");
    await settle();
    expect(tiles(host)).toHaveLength(1);
    expect(byId(host, "media-updating")).not.toBeNull();
    next.release(mediaPage([row(3)]));
    await settle();
    expect(byId(host, "media-updating")).toBeNull();
    expect(tile(host, 3)).toBeDefined();
  });

  it("the search clear button has a name in the page's language", async () => {
    const { host } = await visit(listOf(row(1)), "ar");
    type(byId(host, "media-search") as HTMLInputElement, "x");
    const clear = host.querySelector<HTMLButtonElement>('[data-testid="media-search-clear"]');
    expect(clear?.getAttribute("aria-label")).toBe("مسح البحث");
  });
});

describe("Show more", () => {
  it("sends the cursor, appends, drops a repeated id, and is gone after the last page", async () => {
    const { host, stub } = await visit({
      mediaList: (query) =>
        query.has("cursor") ? mediaPage([row(2), row(3)]) : mediaPage([row(1), row(2)], idOf(2)),
    });
    click(byId(host, "media-more") as HTMLElement);
    await settle();
    expect(listCalls(stub).at(-1)?.searchParams.get("cursor")).toBe(idOf(2));
    expect(tiles(host).map((one) => one.dataset.mediaId)).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(byId(host, "media-more")).toBeNull();
  });

  it("a failed next page keeps the tiles and offers Show more again", async () => {
    const { host } = await visit({
      mediaList: (query) =>
        query.has("cursor") ? refusal("internal_error", 500) : mediaPage([row(1)], idOf(1)),
    });
    click(byId(host, "media-more") as HTMLElement);
    await settle();
    expect(tiles(host)).toHaveLength(1);
    expect(byId(host, "media-more-error")).not.toBeNull();
    expect(byId(host, "media-more")).not.toBeNull();
  });

  it("a next page asked for under the old filters never joins the new filter's tiles", async () => {
    const late = deferred();
    const { host } = await visit({
      mediaList: (query) => {
        if (query.has("cursor")) return late.answer();
        return query.has("q") ? mediaPage([row(5)]) : mediaPage([row(1)], idOf(1));
      },
    });
    click(byId(host, "media-more") as HTMLElement);
    const search = byId(host, "media-search") as HTMLInputElement;
    type(search, "beach");
    press(search, "Enter");
    await settle();
    late.release(mediaPage([row(2)], idOf(2)));
    await settle();
    expect(tiles(host).map((one) => one.dataset.mediaId)).toEqual([idOf(5)]);
    expect(byId(host, "media-more")).toBeNull();
  });

  it("a page that is not the server's shape is a failed read, not an empty library", async () => {
    const { host } = await visit({
      mediaList: () => json({ data: [{ id: "x" }], meta: { next_cursor: null } }),
    });
    expect(stateOf(host)).toBe("failed");
  });
});
