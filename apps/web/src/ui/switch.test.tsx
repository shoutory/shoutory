import { afterEach, describe, expect, it, vi } from "vitest";
import { click, closeApp, mount } from "../../test/support/app";
import { Switch } from "./switch";

afterEach(closeApp);

const control = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[role="switch"]');

describe("the kit Switch", () => {
  it("is named by its label, shows its state, and a click asks for the opposite once", () => {
    const onChange = vi.fn();
    const host = mount(<Switch label="Allow sign-up" isSelected={false} onChange={onChange} />);
    expect(host.textContent).toContain("Allow sign-up");
    expect(control(host)?.checked).toBe(false);
    click(control(host) as HTMLElement);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });
});
