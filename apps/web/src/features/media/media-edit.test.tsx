import { afterEach, describe, expect, it } from "vitest";
import {
  type Api,
  CONNECT_WS,
  callsTo,
  click,
  closeApp,
  json,
  mediaRow,
  openApp,
  refusal,
  settle,
  stubApi,
  type,
  uuidWorkspaces,
} from "../../../test/support/app";

afterEach(closeApp);

const ID = "0190a000-0000-7000-8000-00000000f002";
const PATH = `/w/${CONNECT_WS}/media/${ID}`;

const byId = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const reasonOf = (button: HTMLElement | null) =>
  document.getElementById(button?.getAttribute("aria-describedby") ?? "")?.textContent ?? "";

const medium = (change: Record<string, unknown> = {}) =>
  json({ data: { ...mediaRow({ id: ID }), post_count: 0, actions: ["edit", "delete"], ...change } });

async function visit(api: Api = {}) {
  const stub = stubApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(PATH);
  await settle();
  return { stub, ...opened };
}

async function confirmDelete(host: HTMLElement) {
  await click(byId(host, "detail-delete") as HTMLElement);
  await settle();
  await click(byId(document.body, "delete-confirm") as HTMLElement);
  await settle();
}

describe("what the caller may do with one media file", () => {
  it.each<[string, string, string[], boolean, boolean]>([
    ["an editor of a ready file", "ready", ["edit", "delete"], true, true],
    ["an approver", "ready", [], false, false],
    ["an editor of a file still processing", "processing", ["edit"], true, false],
  ])("%s gets only the controls the server lists (floor)", async (_who, state, actions, edit, del) => {
    const { host } = await visit({ medium: () => medium({ state, actions }) });
    expect(byId(host, "detail-edit") !== null).toBe(edit);
    const remove = byId(host, "detail-delete");
    expect(remove !== null).toBe(edit);
    if (remove) expect(remove.getAttribute("aria-disabled") === "true").toBe(!del);
    if (edit && !del) expect(reasonOf(remove)).not.toBe("");
  });
});

const field = (id: string) => byId(document.body, id) as HTMLInputElement;

async function openEdit(host: HTMLElement) {
  await click(byId(host, "detail-edit") as HTMLElement);
  await settle();
}

describe("editing one media file", () => {
  it("sends the whole tag list, shows the server's row and returns focus to Edit", async () => {
    const saved = medium({ file_name: "server.png", tags: ["kept", "spring"] });
    const { host, stub } = await visit({
      medium: () => medium({ tags: ["kept", "old"] }),
      mediaPatch: () => saved,
    });
    await openEdit(host);
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-labelledby")).toBeTruthy();
    const remove = document.querySelector<HTMLElement>('[aria-label="Remove tag old"]');
    await click(remove as HTMLElement);
    type(field("edit-tag"), "spring");
    await click(byId(document.body, "edit-tag-add") as HTMLElement);
    type(field("edit-name"), " renamed.png ");
    await click(byId(document.body, "edit-save") as HTMLElement);
    await settle();
    const [, init] = callsTo(stub, "PATCH", `/media/${ID}`)[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ file_name: "renamed.png", tags: ["kept", "spring"] });
    expect(byId(document.body, "edit-dialog")).toBeNull();
    expect(byId(host, "detail-name")?.textContent).toBe("server.png");
    expect(document.activeElement).toBe(byId(host, "detail-edit"));
  });

  it.each<[string, () => Response, string]>([
    ["a 400", () => refusal("validation_failed", 400), "The name or a tag was not accepted"],
    ["a 500", () => refusal("internal_error", 500), "We could not save your changes"],
  ])("%s keeps the dialog open and says nothing changed", async (_name, answer, words) => {
    const { host } = await visit({ mediaPatch: answer });
    await openEdit(host);
    await click(byId(document.body, "edit-save") as HTMLElement);
    await settle();
    expect(byId(document.body, "edit-dialog")?.textContent).toContain(words);
    expect(byId(document.body, "edit-dialog")?.textContent).toContain("Nothing was changed.");
    expect(byId(host, "detail-name")?.textContent).toBe("photo.png");
  });

  it("an empty name or a long tag is named on its field and sends nothing", async () => {
    const { host, stub } = await visit();
    await openEdit(host);
    type(field("edit-tag"), "t".repeat(65));
    await click(byId(document.body, "edit-tag-add") as HTMLElement);
    type(field("edit-name"), "  ");
    await click(byId(document.body, "edit-save") as HTMLElement);
    await settle();
    expect(field("edit-tag").getAttribute("aria-invalid")).toBe("true");
    expect(field("edit-name").getAttribute("aria-invalid")).toBe("true");
    expect(callsTo(stub, "PATCH", `/media/${ID}`)).toHaveLength(0);
  });
});

describe("saving tags and waiting for the answer", () => {
  it("a tag typed but not added is saved with the rest", async () => {
    const { host, stub } = await visit();
    await openEdit(host);
    type(field("edit-tag"), " spring ");
    await click(byId(document.body, "edit-save") as HTMLElement);
    await settle();
    const [, init] = callsTo(stub, "PATCH", `/media/${ID}`)[0] ?? [];
    expect(JSON.parse(String(init?.body)).tags).toEqual(["spring"]);
  });

  it("while a save runs only Save is unavailable", async () => {
    const { host } = await visit({ mediaPatch: () => new Promise<Response>(() => undefined) });
    await openEdit(host);
    await click(byId(document.body, "edit-save") as HTMLElement);
    expect(byId(document.body, "edit-save")?.getAttribute("aria-disabled")).toBe("true");
    expect(byId(document.body, "edit-cancel")?.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("the delete dialog and a file in use", () => {
  it("the dialog names the file, Cancel holds focus, and closing returns it to Delete", async () => {
    const { host } = await visit();
    await click(byId(host, "detail-delete") as HTMLElement);
    await settle();
    expect(byId(document.body, "delete-impact")?.textContent).toContain("photo.png");
    const labelled = document.querySelector('[role="dialog"]')?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelled)?.textContent).toBe("Delete this file?");
    expect(document.activeElement).toBe(byId(document.body, "delete-cancel"));
    await click(byId(document.body, "delete-cancel") as HTMLElement);
    await settle();
    expect(document.activeElement).toBe(byId(host, "detail-delete"));
  });

  it("a file two posts use says so on Delete and sends no request (floor)", async () => {
    const { host, stub } = await visit({ medium: () => medium({ post_count: 2 }) });
    const remove = byId(host, "detail-delete");
    expect(remove?.getAttribute("aria-disabled")).toBe("true");
    expect(reasonOf(remove)).toBe("In use by 2 posts: cannot delete");
    await click(remove as HTMLElement);
    await settle();
    expect(byId(document.body, "delete-dialog")).toBeNull();
    expect(callsTo(stub, "DELETE", `/media/${ID}`)).toHaveLength(0);
  });

  it("an in_use refusal at no counted post names the pending send and keeps the file (floor)", async () => {
    const { host } = await visit({ mediaDelete: () => refusal("conflict", 409, { reason: "in_use" }) });
    await confirmDelete(host);
    expect(byId(document.body, "delete-error")?.textContent).toContain(
      "A post, a pending send or the workspace picture still uses this file.",
    );
    expect(byId(host, "detail-name")?.textContent).toBe("photo.png");
  });
});

describe("refusals of a delete", () => {
  it("a refused role keeps the dialog open and says why", async () => {
    let reads = 0;
    const { host } = await visit({
      medium: () => (reads++ === 0 ? medium() : medium({ state: "processing", actions: ["edit"] })),
      mediaDelete: () => refusal("forbidden", 403),
    });
    await confirmDelete(host);
    expect(byId(document.body, "delete-error")?.textContent).toContain("You cannot delete this file");
    expect(reads).toBe(1);
  });

  it("a not_deletable refusal reads the file again so Delete says why", async () => {
    let reads = 0;
    const { host } = await visit({
      medium: () => (reads++ === 0 ? medium() : medium({ state: "processing", actions: ["edit"] })),
      mediaDelete: () => refusal("conflict", 409, { reason: "not_deletable" }),
    });
    await confirmDelete(host);
    await settle();
    expect(reads).toBe(2);
    expect(reasonOf(byId(host, "detail-delete"))).toBe("This file can be deleted once it is ready.");
  });

  it.each<[string, () => Response]>([
    ["204", () => new Response(null, { status: 204 })],
    ["404", () => refusal("not_found", 404)],
  ])(
    "a delete answering %s shows the not-found page with focus on Back to the library (floor)",
    async (_s, answer) => {
      const { host } = await visit({ mediaDelete: answer });
      await confirmDelete(host);
      expect(byId(host, "not-found")).not.toBeNull();
      expect(document.activeElement).toBe(byId(host, "media-detail-back"));
    },
  );
});
