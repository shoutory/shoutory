import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DirText } from "./dir-text";
import { LocalizedDateTime, LocalizedNumber } from "./localized";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => document.body.replaceChildren());

function render(locale: "en" | "ar", element: React.ReactElement) {
  i18n.load(locale, {});
  i18n.activate(locale);
  const host = document.body.appendChild(document.createElement("div"));
  act(() => createRoot(host).render(<I18nProvider i18n={i18n}>{element}</I18nProvider>));
  return host;
}

const INSTANT = new Date("2026-11-19T12:00:00Z");

describe("DirText", () => {
  it("isolates user text with its own direction and language", () => {
    const host = render(
      "en",
      <DirText lang="ar" dir="rtl">
        اسم
      </DirText>,
    );
    const text = host.querySelector("bdi");
    expect(text?.getAttribute("dir")).toBe("rtl");
    expect(text?.getAttribute("lang")).toBe("ar");
    expect(text?.textContent).toBe("اسم");
  });

  it("lets the browser pick the direction of text of unknown direction", () => {
    const host = render("ar", <DirText>order-42</DirText>);
    expect(host.querySelector("bdi")?.getAttribute("dir")).toBe("auto");
  });
});

describe("localized values", () => {
  it.each([
    ["en", "1,234,567.89"],
    ["ar", "1,234,567.89"],
  ] as const)("a number in %s uses Latin digits", (locale, expected) => {
    const host = render(locale, <LocalizedNumber value={1234567.89} />);
    expect(host.textContent).toBe(expected);
  });

  it("a date-time names its time zone and carries the instant in the time element", () => {
    const host = render("en", <LocalizedDateTime value={INSTANT} timeZone="UTC" />);
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-19T12:00:00.000Z");
    expect(host.textContent).toContain("November 19, 2026");
    expect(host.textContent).toMatch(/UTC/);
  });

  it("an Arabic date-time keeps Latin digits and the Gregorian calendar", () => {
    const host = render("ar", <LocalizedDateTime value={INSTANT} timeZone="UTC" />);
    expect(host.textContent).toContain("2026");
    expect(host.textContent).not.toMatch(/[٠-٩]/);
  });
});
