import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogFallback } from "./catalog-fallback";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => document.body.replaceChildren());

// R377: when no message catalog loads, the page still says what happened, in fixed English, with no i18n provider.
describe("the catalog-load fallback", () => {
  it("renders English text and a way to retry without any provider", () => {
    const host = document.body.appendChild(document.createElement("div"));
    act(() => createRoot(host).render(<CatalogFallback />));
    expect(host.querySelector("h1")?.textContent).toMatch(/could not load/i);
    expect(host.querySelector("main")).not.toBeNull();
    expect(host.querySelector("button")?.textContent).toMatch(/reload/i);
  });
});
