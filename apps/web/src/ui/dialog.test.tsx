import { afterEach, describe, expect, it } from "vitest";
import { closeApp, mount } from "../../test/support/app";
import { Dialog } from "./dialog";

afterEach(closeApp);

// ux-spec 4.8 and 4.10: the title is the dialog's accessible name (Escape and focus return are React Aria's own).
describe("Dialog", () => {
  it("has its title as accessible name", () => {
    mount(
      <Dialog title="Rename the workspace" isOpen onOpenChange={() => undefined}>
        <p>Body text</p>
      </Dialog>,
    );
    const dialog = document.querySelector('[role="dialog"]');
    const nameId = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(nameId)?.textContent).toBe("Rename the workspace");
  });
});
