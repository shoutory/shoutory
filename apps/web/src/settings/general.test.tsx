import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  callsTo,
  click,
  closeApp,
  combobox,
  mediaPage,
  mediaRow,
  openApp,
  pageOf,
  refusal,
  roleOf,
  settle,
  stubApi,
  type,
  WORKSPACES,
  type Workspace,
} from "../../test/support/app";

afterEach(closeApp);

const PATH = "/w/w1/settings/general";
const input = (host: ParentNode, name: string) =>
  host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
const save = (host: ParentNode) => byText<HTMLButtonElement>(host, "button", "Save");
const patches = (stub: ReturnType<typeof stubApi>) =>
  stub.mock.calls.filter(([url, init]) => url === "/api/v1/workspaces/w1" && init?.method === "PATCH");
async function change(api: Parameters<typeof stubApi>[0], edits: Record<string, string>) {
  const stub = stubApi(api);
  const opened = await openApp(PATH);
  for (const [name, value] of Object.entries(edits))
    type(input(opened.host, name) as HTMLInputElement, value);
  click(save(opened.host));
  await settle();
  return { ...opened, stub };
}

describe("the workspace General page", () => {
  it("shows the current name, slug and zone, and says Unsaved changes after an edit and Saved after the answer", async () => {
    stubApi();
    const { host } = await openApp(PATH);
    expect([input(host, "name")?.value, input(host, "slug")?.value]).toEqual(["Acme One", "acme-one"]);
    expect(combobox(host, "Time zone").value).toBe("Cairo");
    expect(host.textContent).not.toMatch(/unsaved changes/i);
    type(input(host, "name") as HTMLInputElement, "Renamed");
    expect(host.textContent).toMatch(/unsaved changes/i);
    click(save(host));
    await settle();
    expect(host.textContent).toMatch(/saved/i);
    expect(host.textContent).not.toMatch(/unsaved changes/i);
  });

  it.each([
    ["the name", { name: "Renamed" }],
    ["the name and the slug", { name: "Renamed", slug: "renamed" }],
  ])("changing %s sends only what changed", async (_what, edits) => {
    const { stub } = await change({}, edits);
    expect(JSON.parse(String(patches(stub)[0]?.[1]?.body))).toEqual(edits);
  });

  it("an empty name is refused before any call", async () => {
    const { stub, host } = await change({}, { name: "  " });
    expect(patches(stub)).toHaveLength(0);
    expect(host.textContent).toMatch(/enter a name/i);
  });

  it("a slug that is taken shows its own words and keeps what was typed", async () => {
    const { host } = await change({ patchWorkspace: () => refusal("conflict", 409) }, { slug: "taken" });
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/already used/i);
    expect(input(host, "slug")?.value).toBe("taken");
  });

  it("the colour is one of eight swatches with no way to clear it, and sends its #rrggbb value", async () => {
    const stub = stubApi();
    const { host } = await openApp(PATH);
    const swatches = [...host.querySelectorAll<HTMLInputElement>('input[name="colour"]')];
    expect(swatches).toHaveLength(8);
    expect(host.textContent).not.toMatch(/no colour|clear/i);
    click(swatches[1] as HTMLInputElement);
    click(save(host));
    await settle();
    expect(JSON.parse(String(patches(stub)[0]?.[1]?.body)).colour).toMatch(/^#[0-9a-f]{6}$/);
  });
});

const GONE = "2026-11-25T10:00:00.000Z";
const withW1 = (change: Partial<Workspace>) =>
  pageOf(WORKSPACES.map((workspace) => (workspace.id === "w1" ? { ...workspace, ...change } : workspace)));

describe("archive on the workspace General page", () => {
  it("an archived workspace reads as read-only: banner with Restore, fields locked, no Archive or picture choice", async () => {
    const stub = stubApi({ workspaces: withW1({ archived_at: GONE }) });
    const { host } = await openApp(PATH);
    expect(host.querySelector('[data-testid="archived-banner"]')?.textContent).toMatch(
      /acme one is archived/i,
    );
    expect(input(host, "name")?.readOnly).toBe(true);
    expect(save(host).getAttribute("aria-disabled")).toBe("true");
    expect(host.querySelector('[data-testid="workspace-archive"]')).toBeNull();
    expect(host.querySelector('[data-testid="avatar-choose"]')).toBeNull();
    click(host.querySelector('[data-testid="workspace-restore"]') as HTMLElement);
    await settle();
    expect(callsTo(stub, "POST", "/api/v1/workspaces/w1/unarchive")).toHaveLength(1);
  });

  it("a refused Restore names the reason and keeps the workspace archived with Restore offered", async () => {
    stubApi({
      workspaces: withW1({ archived_at: GONE }),
      archive: () => refusal("conflict", 409, { reason: "deletion_requested" }),
    });
    const { host } = await openApp(PATH);
    click(host.querySelector('[data-testid="workspace-restore"]') as HTMLElement);
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/being deleted/i);
    expect(host.querySelector('[data-testid="archived-banner"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="workspace-restore"]')).not.toBeNull();
  });

  it("a workspace of a personal organization has no Archive control", async () => {
    stubApi({ workspaces: withW1({ organization_type: "personal" }) });
    const { host } = await openApp(PATH);
    expect(input(host, "name")?.value).toBe("Acme One");
    expect(host.querySelector('[data-testid="workspace-archive"]')).toBeNull();
  });

  it("a save refused because the workspace was archived meanwhile says so, not that the name is taken", async () => {
    const archived = () => refusal("conflict", 409, { reason: "workspace_archived" });
    const { host } = await change({ patchWorkspace: archived }, { slug: "renamed" });
    const alert = host.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toMatch(/this workspace is archived/i);
    expect(alert).not.toMatch(/already used/i);
  });
});

const IMAGE = "0190a000-0000-7000-8000-0000000000f1";

describe("the workspace picture", () => {
  async function choose(api: Parameters<typeof stubApi>[0] = {}) {
    const stub = stubApi({ mediaList: () => mediaPage([mediaRow()]), ...api });
    const opened = await openApp(PATH);
    click(opened.host.querySelector('[data-testid="avatar-choose"]') as HTMLElement);
    await settle();
    return { ...opened, stub };
  }

  it("lists only ready images and sets the one chosen", async () => {
    let asked: URLSearchParams | undefined;
    const { stub } = await choose({
      mediaList: (query) => {
        asked = query;
        return mediaPage([mediaRow()]);
      },
    });
    expect([asked?.get("type"), asked?.get("state")]).toEqual(["image", "ready"]);
    const tile = document.body.querySelector('[data-testid="avatar-choice"]') as HTMLElement;
    expect(tile.getAttribute("aria-label")).toBe("Use photo.png");
    click(tile);
    await settle();
    expect(JSON.parse(String(patches(stub)[0]?.[1]?.body))).toEqual({ avatar: IMAGE });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Show more reads the next page by its cursor and adds its images after the first", async () => {
    const { stub } = await choose({ mediaList: () => mediaPage([mediaRow()], "next-1") });
    click(byText(document.body, '[role="dialog"] button', "Show more images"));
    await settle();
    expect(callsTo(stub, "GET", "cursor=next-1")).toHaveLength(1);
    expect(document.body.querySelectorAll('[data-testid="avatar-choice"]')).toHaveLength(2);
  });

  it("an empty library says there are no images yet", async () => {
    await choose({ mediaList: () => mediaPage([]) });
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toMatch(/no images yet/i);
  });

  it("an image that can no longer be used has its own words", async () => {
    await choose({
      patchWorkspace: () => refusal("unprocessable_content", 422, { reason: "media_unavailable" }),
    });
    click(document.body.querySelector('[data-testid="avatar-choice"]') as HTMLElement);
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(/can no longer be used/i);
  });

  it("Remove picture sends null", async () => {
    const stub = stubApi({ workspaces: withW1({ avatar: IMAGE }) });
    const { host } = await openApp(PATH);
    click(host.querySelector('[data-testid="avatar-remove"]') as HTMLElement);
    await settle();
    expect(JSON.parse(String(patches(stub)[0]?.[1]?.body))).toEqual({ avatar: null });
  });
});

describe("the workspace General page for a role that may only read", () => {
  it.each(["editor", "viewer"])("a %s reads the settings and cannot save", async (role) => {
    const { stub, host } = await change({ workspaces: roleOf(role) }, {});
    expect(input(host, "name")?.value).toBe("Acme One");
    expect(save(host).getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).toMatch(/need the admin role/i);
    expect(patches(stub)).toHaveLength(0);
  });

  it.each(["editor", "viewer"])(
    "a %s who picks another zone and submits the form sends nothing",
    async (role) => {
      const stub = stubApi({ workspaces: roleOf(role) });
      const { host } = await openApp(PATH);
      const zone = combobox(host, "Time zone");
      type(zone, "Dubai");
      click(document.body.querySelector<HTMLElement>('[role="option"]') ?? zone);
      act(() => host.querySelector("form")?.requestSubmit());
      await settle();
      expect(zone.readOnly).toBe(true);
      expect(patches(stub)).toHaveLength(0);
    },
  );
});
