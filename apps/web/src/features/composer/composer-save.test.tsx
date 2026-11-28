import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, closeApp, json, openApp, refusal, settle } from "../../../test/support/app";
import {
  allById,
  byId,
  type Call,
  CH,
  callsOf,
  detailOf,
  field,
  POST,
  stubComposerApi,
  typeInto,
  VERSION_1,
  VERSION_2,
  VERSION_3,
  variantRow,
} from "../../../test/support/composer-api";

afterEach(() => {
  vi.restoreAllMocks();
  closeApp();
});

const created = () => json({ data: { id: POST, version_id: VERSION_1 } }, 201);
const patched = (version = VERSION_2) =>
  json({ data: { id: POST, version_id: version, pending_changes: [] } });

async function open(answer: (call: Call) => Response | undefined, path = "/w/w1/posts/new") {
  const stub = stubComposerApi({ answer });
  const opened = await openApp(path);
  await settle();
  return { stub, ...opened };
}

const pickShort = async () => {
  const label = allById("picker-channel").find((one) => one.querySelector("input")?.value === CH.short);
  await click(label as HTMLElement);
  await settle();
};

const after = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const write = async (text: string) => {
  typeInto(field("composer-base"), text);
  await settle();
};

const SAVED = [variantRow(CH.short, "Draft one")];

describe("saving as the person writes", () => {
  it("the first change creates the post after two quiet seconds, then each change is saved against the version it saw", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub, router } = await open((call) => {
      if (call.method === "POST" && call.path === "posts") return created();
      if (call.method === "PATCH") return patched();
      if (call.method === "GET" && call.path === `posts/${POST}`) return detailOf(SAVED);
      return undefined;
    });
    await pickShort();
    await write("Draft one");
    await after(1999);
    expect(callsOf(stub, "POST", "/posts")).toHaveLength(0);
    await after(1);
    const [made] = callsOf(stub, "POST", "/posts");
    expect(made?.body).toEqual({ draft: { variants: [variantRow(CH.short, "Draft one")] } });
    expect(router.state.location.pathname).toBe(`/w/w1/posts/${POST}/edit`);
    await write("Draft two");
    await after(2000);
    const [changed] = callsOf(stub, "PATCH", `/posts/${POST}`);
    expect(changed?.headers["If-Match"]).toBe(`"${VERSION_1}"`);
    expect(byId("save-indicator")?.textContent).toContain("Saved");
    expect(byId("save-announce")?.textContent).toBe("");
  });

  it("nothing is sent for a post with no channel, and the indicator says so", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub } = await open(() => undefined);
    await write("Words but nowhere to send them");
    await after(5000);
    expect(callsOf(stub, "POST", "/posts")).toHaveLength(0);
    expect(byId("save-indicator")?.textContent).toContain("Unsaved");
  });
});

describe("a save that has to wait", () => {
  it("is tried again after the pause, and not at all once the composer is gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub, router } = await open((call) => {
      if (call.method === "PATCH") return refusal("too_many_requests", 429);
      if (call.method === "GET" && call.path === `posts/${POST}`) return detailOf(SAVED);
      return undefined;
    }, `/w/w1/posts/${POST}/edit`);
    await write("Changed words");
    await after(2000);
    await settle();
    expect(byId("save-indicator")?.getAttribute("data-state")).toBe("paused");
    expect(callsOf(stub, "PATCH", `/posts/${POST}`)).toHaveLength(1);
    await act(async () => {
      await router.navigate("/w/w1/posts");
    });
    expect(byId("save-indicator")).toBeNull();
    await after(10_000);
    expect(callsOf(stub, "PATCH", `/posts/${POST}`)).toHaveLength(1);
  });
});

describe("offline", () => {
  const BUFFER = "shoutory.composer.w1.new";

  it("keeps the words on this device and says they are not on the server", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { stub } = await open(() => undefined);
    await pickShort();
    await write("Written offline");
    await after(3000);
    expect(callsOf(stub, "POST", "/posts")).toHaveLength(0);
    expect(byId("save-indicator")?.textContent).toContain("Not saved to the server");
    expect(byId("save-announce")?.textContent).toContain("Not saved to the server");
    expect(JSON.parse(localStorage.getItem(BUFFER) ?? "{}").doc.base).toBe("Written offline");
  });

  it("offers the kept words on reopening and restores them on request", async () => {
    const doc = {
      base: "Buffered words",
      baseMedia: [],
      variants: [
        {
          channelId: CH.short,
          locale: null,
          postType: "text",
          override: null,
          threadParts: [],
          firstComment: "",
          mediaOverride: null,
          settings: {},
        },
      ],
    };
    localStorage.setItem(BUFFER, JSON.stringify({ at: "2026-11-28T10:00:00.000Z", doc }));
    await open(() => undefined);
    expect(byId("restore-offer")?.textContent).toContain("We found unsaved changes");
    await click(byId("restore-yes") as HTMLElement);
    await settle();
    expect(field("composer-base").value).toBe("Buffered words");
    expect(byId("restore-offer")).toBeNull();
  });

  it("a storage that refuses is not a failure", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await open(() => undefined);
    await pickShort();
    await write("Still works");
    expect(field("composer-base").value).toBe("Still works");
  });
});

describe("what is announced about saving", () => {
  it("says so when saving works again after it did not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await open((call) => {
      if (call.method === "POST" && call.path === "posts") return created();
      if (call.method === "PATCH") return patched();
      if (call.method === "GET" && call.path === `posts/${POST}`) return detailOf(SAVED);
      return undefined;
    });
    await pickShort();
    await write("Written offline");
    await after(3000);
    const live = byId("save-announce");
    expect(live?.textContent).toContain("Not saved to the server");
    onLine.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await after(2000);
    await settle();
    expect(byId("save-indicator")?.textContent).toContain("Saved");
    expect(byId("save-announce")).toBe(live);
    expect(live?.textContent).toContain("Saved again");
  });
});

const theirs = () =>
  json({
    data: {
      id: VERSION_3,
      version_no: 3,
      kind: "save",
      created_by: "u2",
      created_at: "2026-11-28T10:00:00.000Z",
      draft: { variants: [variantRow(CH.short, "Their words")] },
    },
  });

async function stale(theirReads: (read: number) => Response = theirs) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let patches = 0;
  let reads = 0;
  const opened = await open((call) => {
    if (call.method === "PATCH") {
      patches += 1;
      return patches === 1
        ? refusal("precondition_failed", 412, { current_version_id: VERSION_3 })
        : patched();
    }
    if (call.method === "GET" && call.path.endsWith(`versions/${VERSION_3}`)) return theirReads(reads++);
    if (call.method === "GET" && call.path === `posts/${POST}`) return detailOf(SAVED);
    return undefined;
  }, `/w/w1/posts/${POST}/edit`);
  await write("Mine, a bit changed");
  await after(2000);
  await settle();
  return opened;
}

describe("a draft changed elsewhere", () => {
  it("shows both versions and keeping mine saves again against the newer version", async () => {
    const { stub } = await stale();
    const dialog = byId("conflict-dialog");
    expect(dialog?.textContent).toContain("Mine, a bit changed");
    expect(dialog?.textContent).toContain("Their words");
    await click(byId("conflict-mine") as HTMLElement);
    await settle();
    const patches = callsOf(stub, "PATCH", `/posts/${POST}`);
    expect(patches).toHaveLength(2);
    expect(patches[1]?.headers["If-Match"]).toBe(`"${VERSION_3}"`);
    expect(byId("conflict-dialog")).toBeNull();
  });

  it("using theirs replaces the text and sends nothing", async () => {
    const { stub } = await stale();
    await click(byId("conflict-theirs") as HTMLElement);
    await settle();
    expect(field("composer-base").value).toBe("Their words");
    expect(callsOf(stub, "PATCH", `/posts/${POST}`)).toHaveLength(1);
  });
});

describe("a conflicted draft whose other version cannot be read", () => {
  it("says so, offers Try again and keeps Keep mine off until it is read", async () => {
    const { stub } = await stale((read) => (read === 0 ? refusal("internal_error", 500) : theirs()));
    const dialog = byId("conflict-dialog");
    expect(dialog?.textContent).toContain("We could not load their version");
    expect(byId("conflict-mine")?.getAttribute("aria-disabled")).toBe("true");
    expect(byId("conflict-theirs")?.getAttribute("aria-disabled")).toBe("true");
    await click(byId("conflict-mine") as HTMLElement);
    await settle();
    expect(callsOf(stub, "PATCH", `/posts/${POST}`)).toHaveLength(1);
    await click(byId("conflict-retry") as HTMLElement);
    await settle();
    expect(byId("conflict-dialog")?.textContent).toContain("Their words");
    expect(byId("conflict-mine")?.getAttribute("aria-disabled")).not.toBe("true");
  });
});
