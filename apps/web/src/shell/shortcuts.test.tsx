import { afterEach, describe, expect, it } from "vitest";
import { byText, click, closeApp, openApp, stubApi } from "../../test/support/app";

afterEach(closeApp);

describe("the keyboard shortcuts list", () => {
  it("opens from the account menu and names every shortcut with what it does", async () => {
    stubApi();
    const { host } = await openApp("/w/w1");
    click(byText(host, "button", "Account"));
    click(byText(document.body, "button", "Keyboard shortcuts"));
    const dialog = document.querySelector('[role="dialog"]');
    const name = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")?.textContent;
    expect(name).toBe("Keyboard shortcuts");
    const rows = [...(dialog?.querySelectorAll("dt, dd") ?? [])].map((cell) => cell.textContent);
    expect(rows).toEqual(["Ctrl/Cmd+K", "Switch workspace"]);
  });
});
