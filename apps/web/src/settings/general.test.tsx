import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  combobox,
  openApp,
  refusal,
  roleOf,
  settle,
  stubApi,
  type,
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

describe("the workspace General page for a role that may only read", () => {
  // A role without settings.manage reads the page and changes nothing: the controls say why and no PATCH leaves.
  it.each(["editor", "viewer"])("a %s reads the settings and cannot save", async (role) => {
    const { stub, host } = await change({ workspaces: roleOf(role) }, {});
    expect(input(host, "name")?.value).toBe("Acme One");
    expect(save(host).getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).toMatch(/need the admin role/i);
    expect(patches(stub)).toHaveLength(0);
  });

  // The picker is read-only too, and submitting the form (Enter in a field) sends nothing whatever the draft holds.
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
