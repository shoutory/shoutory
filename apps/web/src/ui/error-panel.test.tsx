import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeApp, mount } from "../../test/support/app";
import { ApiError } from "../http/client";
import { ErrorPanel } from "./error-panel";

afterEach(closeApp);

function render(error: ApiError, onRetry?: () => void) {
  return mount(
    <ErrorPanel
      what="We could not load your workspaces"
      meaning="Nothing was changed."
      error={error}
      {...(onRetry ? { onRetry } : {})}
    />,
  );
}

const button = (host: Element, text: string) =>
  [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

// ux-spec 6.2: what happened, what it means for the data, what to do, details with the request id (never the server's
// own words); Retry only when trying again can help.
describe("ErrorPanel", () => {
  it("names what happened and what it means, as an alert, and keeps the request id behind Details", () => {
    const host = render(new ApiError("internal_error", 500, "req-42"), vi.fn());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("We could not load your workspaces");
    expect(host.textContent).toContain("Nothing was changed.");
    expect(host.querySelector("details summary")?.textContent).toBe("Details");
    expect(host.querySelector("details")?.textContent).toContain("req-42");
    expect(host.textContent).not.toMatch(/api call failed|\b500\b/);
  });

  it.each([
    ["a network failure", new ApiError("network", 0), true],
    ["a 503", new ApiError("service_unavailable", 503, "r"), true],
    ["a 500", new ApiError("internal_error", 500, "r"), true],
    ["a 403", new ApiError("forbidden", 403, "r"), false],
    ["a 404", new ApiError("not_found", 404, "r"), false],
    ["a refused input", new ApiError("validation_failed", 400, "r"), false],
  ])("offers Retry for %s only when it can help", (_name, error, retryable) => {
    const onRetry = vi.fn();
    const host = render(error, onRetry);
    expect(button(host, "Retry") !== undefined).toBe(retryable);
    if (retryable) {
      act(() => button(host, "Retry")?.click());
      expect(onRetry).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["without an error, no request id", undefined],
    ["with an error, the request id beside it", new ApiError("internal_error", 500, "req-42")],
  ])("shows a detail node in the one Details %s", (_name, error) => {
    const host = mount(
      <ErrorPanel
        what="We could not connect"
        meaning="Nothing was changed."
        detail={<span data-testid="detail">the provider said so</span>}
        {...(error ? { error } : {})}
      />,
    );
    expect(host.querySelectorAll("details")).toHaveLength(1);
    expect(host.querySelector("details [data-testid='detail']")?.textContent).toBe("the provider said so");
    expect(host.querySelector("details")?.textContent?.includes("req-42")).toBe(error !== undefined);
  });

  it("copies the request id with its own button", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText }, languages: ["en"] });
    const host = render(new ApiError("internal_error", 500, "req-42"));
    act(() => button(host, "Copy")?.click());
    expect(writeText).toHaveBeenCalledWith("req-42");
  });
});
