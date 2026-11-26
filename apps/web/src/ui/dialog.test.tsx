import { afterEach, describe, expect, it } from "vitest";
import { closeApp, mount } from "../../test/support/app";
import { Dialog } from "./dialog";

afterEach(closeApp);

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

  it("is an alert dialog when it asks for an answer before something ends", () => {
    mount(
      <Dialog title="Your session ends soon" role="alertdialog" isOpen onOpenChange={() => undefined}>
        <p>Body text</p>
      </Dialog>,
    );
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  });
});
