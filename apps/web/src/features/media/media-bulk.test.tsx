import { afterEach, describe, expect, it } from "vitest";
import {
  type Api,
  CONNECT_WS,
  callsTo,
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
const tile = (host: ParentNode, n: number) =>
  all(host, "media-tile").find((one) => one.dataset.mediaId === idOf(n)) ?? null;
const part = (host: ParentNode, n: number, id: string) => {
  const found = tile(host, n);
  return found ? byId(found, id) : null;
};
const isSelected = (host: ParentNode, n: number) => tile(host, n)?.getAttribute("aria-selected") === "true";

async function visit(api: Api = {}) {
  const stub = stubApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(PATH);
  await settle();
  return { stub, ...opened };
}
const listOf = (...rows: unknown[]): Api => ({ mediaList: () => mediaPage(rows) });

async function select(host: HTMLElement, ...ns: number[]) {
  for (const n of ns) await click(part(host, n, "tile-select")?.querySelector("input") as HTMLElement);
  await settle();
}

async function bulkDelete(host: HTMLElement) {
  await click(byId(host, "media-bulk-delete") as HTMLElement);
  await settle();
  await click(byId(document.body, "bulk-delete-confirm") as HTMLElement);
  await settle();
  await settle();
}

describe("who may select files (floor)", () => {
  it.each<[string, string[], boolean]>([
    ["rows the caller may edit", ["edit", "delete"], true],
    ["rows of a viewer or an approver", [], false],
  ])("%s: selection and the bulk bar follow the rows' actions", async (_who, actions, offered) => {
    const { host } = await visit(listOf(row(1, { actions }), row(2, { actions })));
    expect(part(host, 1, "tile-select") !== null).toBe(offered);
    if (offered) await select(host, 1);
    expect(byId(host, "media-bulk-bar") !== null).toBe(offered);
  });
});

describe("a bulk delete keeps what the server refuses (floor)", () => {
  it("a selected file that cannot be deleted yet gets no request and stays selected with its reason", async () => {
    const { host, stub } = await visit(
      listOf(row(1), row(2, { state: "processing", derivatives: {}, actions: ["edit"] })),
    );
    await select(host, 1, 2);
    await bulkDelete(host);
    const sent = callsTo(stub, "DELETE", "/media/").map(([url]) => url);
    expect(sent).toEqual([`/api/v1/workspaces/${CONNECT_WS}/media/${idOf(1)}`]);
    expect(tile(host, 1)).toBeNull();
    expect(isSelected(host, 2)).toBe(true);
    expect(part(host, 2, "tile-bulk-error")?.dataset.reason).toBe("not_ready");
  });

  it("an expired session sends nothing more and leads to sign-in", async () => {
    const { host, stub, router } = await visit({
      ...listOf(row(1), row(2)),
      mediaDelete: () => refusal("unauthenticated", 401),
    });
    await select(host, 1, 2);
    await bulkDelete(host);
    expect(callsTo(stub, "DELETE", "/media/")).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it.each<[string, () => Response | Promise<Response>, string | null]>([
    ["a refused role", () => refusal("forbidden", 403), "forbidden"],
    ["a file in use", () => refusal("conflict", 409, { reason: "in_use" }), "in_use"],
    [
      "a file whose state changed",
      () => refusal("conflict", 409, { reason: "not_deletable" }),
      "not_deletable",
    ],
    ["a file already gone", () => refusal("not_found", 404), null],
  ])("%s: the others are deleted and this one is named or dropped", async (_what, answer, reason) => {
    const { host } = await visit({
      ...listOf(row(1), row(2), row(3)),
      mediaDelete: (id) => (id === idOf(2) ? answer() : new Response(null, { status: 204 })),
    });
    await select(host, 1, 2, 3);
    await bulkDelete(host);
    expect(tile(host, 1)).toBeNull();
    expect(tile(host, 3)).toBeNull();
    if (reason === null) expect(tile(host, 2)).toBeNull();
    else {
      expect(isSelected(host, 2)).toBe(true);
      expect(part(host, 2, "tile-bulk-error")?.dataset.reason).toBe(reason);
    }
  });
});

const afterFrame = async () => {
  await new Promise((done) => requestAnimationFrame(done));
  await settle();
};
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.testid;

describe("running a bulk change", () => {
  it("adds one tag to each file's whole list, skipping a file that has it and naming one that is full", async () => {
    const full = Array.from({ length: 32 }, (_, n) => `t${n}`);
    const { host, stub } = await visit({
      ...listOf(row(1, { tags: ["a"] }), row(2, { tags: ["new"] }), row(3, { tags: full })),
      mediaPatch: (id, body) => json({ data: { ...row(1, { id }), ...(body as object), post_count: 0 } }),
    });
    await select(host, 1, 2, 3);
    await click(byId(host, "media-bulk-tag") as HTMLElement);
    await settle();
    type(byId(document.body, "bulk-tag") as HTMLInputElement, " new ");
    await click(byId(document.body, "bulk-tag-confirm") as HTMLElement);
    await settle();
    const sent = callsTo(stub, "PATCH", "/media/").map(([url, init]) => [
      url,
      JSON.parse(String(init?.body)),
    ]);
    expect(sent).toEqual([[`/api/v1/workspaces/${CONNECT_WS}/media/${idOf(1)}`, { tags: ["a", "new"] }]]);
    expect([isSelected(host, 1), isSelected(host, 2), isSelected(host, 3)]).toEqual([false, false, true]);
    expect(part(host, 3, "tile-bulk-error")?.dataset.reason).toBe("tags_full");
  });
});

describe("the bulk tag is checked before anything is sent", () => {
  it.each([
    ["blank", "   "],
    ["too long", "x".repeat(65)],
    ["with a control character", "a\u0007b"],
  ])("a %s tag is refused in the dialog and nothing is sent", async (_what, tag) => {
    const { host, stub } = await visit(listOf(row(1)));
    await select(host, 1);
    await click(byId(host, "media-bulk-tag") as HTMLElement);
    await settle();
    type(byId(document.body, "bulk-tag") as HTMLInputElement, tag);
    await click(byId(document.body, "bulk-tag-confirm") as HTMLElement);
    await settle();
    expect(callsTo(stub, "PATCH", "/media/")).toHaveLength(0);
    expect(byId(document.body, "bulk-tag")?.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("a run ends early", () => {
  let release: () => void = () => undefined;
  const held = () =>
    new Promise<Response>((done) => {
      release = () => done(new Response(null, { status: 204 }));
    });

  it.each<[string, () => Promise<Response>, (string | undefined)[]]>([
    ["a network failure", () => Promise.reject(new TypeError("fetch failed")), ["network", "network"]],
    ["Stop", held, [undefined, undefined]],
  ])("%s ends the run and the files not sent stay selected", async (what, answer, reasons) => {
    const { host, stub } = await visit({ ...listOf(row(1), row(2), row(3)), mediaDelete: answer });
    await select(host, 1, 2, 3);
    await click(byId(host, "media-bulk-delete") as HTMLElement);
    await settle();
    await click(byId(document.body, "bulk-delete-confirm") as HTMLElement);
    await settle();
    if (what === "Stop") {
      await press(byId(document.body, "bulk-stop") as HTMLElement, "Escape");
      expect(byId(document.body, "bulk-progress")).not.toBeNull();
      await click(byId(document.body, "bulk-stop") as HTMLElement);
      release();
      await settle();
    }
    expect(callsTo(stub, "DELETE", "/media/")).toHaveLength(1);
    expect([2, 3].map((n) => isSelected(host, n))).toEqual([true, true]);
    expect([2, 3].map((n) => part(host, n, "tile-bulk-error")?.dataset.reason)).toEqual(reasons);
  });
});

describe("where focus goes", () => {
  it.each<[string, (id: string) => Response, string]>([
    ["every file applied", () => new Response(null, { status: 204 }), "media-heading"],
    [
      "a file refused",
      (id) => (id === idOf(2) ? refusal("forbidden", 403) : new Response(null, { status: 204 })),
      "media-bulk-result",
    ],
  ])("after a run with %s, focus moves on", async (_what, answer, target) => {
    const { host } = await visit({ ...listOf(row(1), row(2)), mediaDelete: answer });
    await select(host, 1, 2);
    await bulkDelete(host);
    await afterFrame();
    expect(focused()).toBe(target);
  });

  it("Cancel sends nothing and returns focus to the bar's button", async () => {
    const { host, stub } = await visit(listOf(row(1)));
    await select(host, 1);
    await click(byId(host, "media-bulk-delete") as HTMLElement);
    await settle();
    await click(byId(document.body, "bulk-delete-cancel") as HTMLElement);
    await afterFrame();
    expect(callsTo(stub, "DELETE", "/media/")).toHaveLength(0);
    expect(focused()).toBe("media-bulk-delete");
  });
});

describe("selecting files", () => {
  it.each<[string, number, number, boolean]>([
    ["the loaded files", 3, 3, false],
    ["more than 100 files: nothing, with a word", 101, 0, true],
  ])("Ctrl+A selects %s", async (_what, count, selected, refused) => {
    const rows = Array.from({ length: count }, (_, n) => row(n + 1));
    const { host } = await visit(listOf(...rows));
    await press(host.querySelector('[role="grid"]') as HTMLElement, "a", { ctrlKey: true });
    await settle();
    expect(
      all(host, "media-tile").filter((one) => one.getAttribute("aria-selected") === "true"),
    ).toHaveLength(selected);
    expect(byId(host, "media-bulk-too-many") !== null).toBe(refused);
  });

  it.each<["en" | "ar", number, string]>([
    ["en", 1, "1 file selected"],
    ["en", 3, "3 files selected"],
    ["ar", 1, "حُدِّد ملف واحد"],
    ["ar", 2, "حُدِّد ملفان"],
    ["ar", 3, "حُدِّدت 3 ملفات"],
    ["ar", 11, "حُدِّد 11 ملفًا"],
  ])("the selected count in %s for %i files", async (locale, count, said) => {
    stubApi({
      workspaces: uuidWorkspaces(),
      ...listOf(...Array.from({ length: count }, (_, n) => row(n + 1))),
    });
    const { host } = await openApp(PATH, locale);
    await settle();
    await select(host, ...Array.from({ length: count }, (_, n) => n + 1));
    expect(byId(host, "media-bulk-count")?.textContent).toBe(said);
  });

  it("a file that leaves the list leaves the selection", async () => {
    let listed = [row(1, { tags: ["spring"] }), row(2)];
    const { host } = await visit({ mediaList: () => mediaPage(listed) });
    await select(host, 1, 2);
    listed = [row(1, { tags: ["spring"] })];
    await click(part(host, 1, "tile-tag") as HTMLElement);
    await settle();
    await click(byId(host, "media-bulk-delete") as HTMLElement);
    await settle();
    expect(byId(document.body, "bulk-delete-impact")?.textContent).toMatch(/^1 file /);
  });
});
