import { afterEach, describe, expect, it } from "vitest";
import { byText, click, closeApp, openApp, press, stubApi, type } from "../../test/support/app";

afterEach(closeApp);

const dialog = () => document.querySelector('[role="dialog"]');
const search = () => document.querySelector<HTMLInputElement>('[role="dialog"] input') as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);

describe("the command palette", () => {
  it.each([
    ["Ctrl+K", { ctrlKey: true }],
    ["Cmd+K", { metaKey: true }],
  ])("%s opens it with the title as its name", async (_name, modifiers) => {
    stubApi();
    await openApp("/w/w1");
    press(document.body, "k", modifiers);
    const name = document.getElementById(dialog()?.getAttribute("aria-labelledby") ?? "")?.textContent;
    expect(name).toBe("Switch workspace");
  });

  it("opens from its visible button, which shows the shortcut", async () => {
    stubApi();
    const { host } = await openApp("/w/w1");
    click(byText(host, "button", "Ctrl/Cmd+K"));
    expect(dialog()).not.toBeNull();
  });

  it("typing filters the workspaces, Enter switches to the chosen one and closes it", async () => {
    stubApi();
    const { router } = await openApp("/w/w1");
    press(document.body, "k", { ctrlKey: true });
    const input = search();
    type(input, "two");
    expect(options()).toEqual(["Acme Two"]);
    press(input, "Enter");
    expect(router.state.location.pathname).toBe("/w/w2");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("h1"));
    press(document.body, "k", { ctrlKey: true });
    expect(search().value).toBe("");
  });

  it("names its search field", async () => {
    stubApi();
    await openApp("/w/w1");
    press(document.body, "k", { ctrlKey: true });
    const input = search();
    const labelled = (input.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect([input.getAttribute("aria-label"), ...labelled]).toContain("Search workspaces");
  });

  it("says Nothing found when no workspace matches", async () => {
    stubApi();
    await openApp("/w/w1");
    press(document.body, "k", { ctrlKey: true });
    type(search(), "zzzz");
    expect(dialog()?.textContent).toContain("Nothing found");
    expect(options().filter((text) => text !== "Nothing found")).toEqual([]);
  });
});
