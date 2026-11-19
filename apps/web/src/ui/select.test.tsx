import { afterEach, describe, expect, it, vi } from "vitest";
import { click, closeApp, mount, optionTexts, press, selectTrigger } from "../../test/support/app";
import { Select } from "./select";

afterEach(closeApp);

const OPTIONS = [
  { value: "admin", label: "Admin" },
  { value: "viewer", label: "Viewer" },
];

describe("the kit Select", () => {
  it("is named by its label and shows the chosen option", () => {
    const host = mount(<Select label="Role" value="viewer" onChange={() => undefined} options={OPTIONS} />);
    // The trigger is found through its aria-labelledby, so this is its accessible name.
    const trigger = selectTrigger(host, "Role");
    expect(trigger.textContent).toContain("Viewer");
  });

  it("opens from the keyboard with every option in order, and choosing one calls onChange once and closes", () => {
    const onChange = vi.fn();
    const host = mount(<Select label="Role" value="viewer" onChange={onChange} options={OPTIONS} />);
    press(selectTrigger(host, "Role"), "Enter");
    expect(optionTexts()).toEqual(["Admin", "Viewer"]);
    click(document.body.querySelector<HTMLElement>('[role="option"]') as HTMLElement);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("admin");
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  });
});
