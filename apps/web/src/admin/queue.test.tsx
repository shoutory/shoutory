import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  json,
  openAdmin,
  QUEUE,
  refusal,
  rowOf,
  settle,
} from "../../test/support/app";

afterEach(closeApp);

const PATH = "/admin/queue";

describe("the queue health screen", () => {
  it("lists each worker, marks a silent one stale, and shows the lags", async () => {
    const { host } = await openAdmin(PATH);
    expect(host.querySelector("h1")?.textContent).toBe("Queue health");
    expect(rowOf(host, "worker-fresh").textContent).not.toMatch(/stale/i);
    expect(rowOf(host, "worker-silent").textContent).toMatch(/stale \(worker silent\)/i);
    expect(host.textContent).toContain("12");
    expect(host.textContent).toContain("3");
  });

  it.each(["Stuck operations", "Reconciler backlog"])(
    "shows %s as not available, never a zero",
    async (name) => {
      const { host } = await openAdmin(PATH);
      const line = [...host.querySelectorAll("dt")].find((term) => term.textContent === name);
      expect(line?.nextElementSibling?.textContent).toMatch(/not available/i);
    },
  );

  it("says the job queue is not installed instead of showing a lag", async () => {
    const queue = { ...QUEUE, jobs: { installed: false, lag_seconds: null } };
    const { host } = await openAdmin(PATH, { adminQueue: () => json({ data: queue }) });
    expect(host.textContent).toMatch(/job queue is not installed/i);
  });

  it("says no worker has reported instead of showing an empty table", async () => {
    const { host } = await openAdmin(PATH, { adminQueue: () => json({ data: { ...QUEUE, workers: [] } }) });
    expect(host.textContent).toMatch(/no worker has reported/i);
    expect(host.querySelector("table")).toBeNull();
  });

  it("claims nothing healthy before the answer", async () => {
    const { host } = await openAdmin(PATH, { adminQueue: () => new Promise<Response>(() => undefined) });
    expect(host.textContent).not.toMatch(/healthy|not available/i);
  });

  it("a failed read shows the error panel with Retry and keeps the admin frame", async () => {
    const { host } = await openAdmin(PATH, { adminQueue: () => refusal("service_unavailable", 503) });
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
    expect(host.querySelector('nav[aria-label="Admin sections"]')).not.toBeNull();
    click(byText(host.querySelector("main") as HTMLElement, "button", "Retry"));
    await settle();
  });
});
