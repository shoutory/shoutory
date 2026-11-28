import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { click, closeApp, json, mediaPage, mediaRow, openApp, settle } from "../../../test/support/app";
import {
  allById,
  byId,
  type Call,
  CH,
  detailOf,
  POST,
  stubComposerApi,
  typeInto,
  variantRow,
} from "../../../test/support/composer-api";

afterEach(closeApp);

const ID_1 = "0190a000-0000-7000-8000-0000000000f1";
const ID_2 = "0190a000-0000-7000-8000-0000000000f2";
const ID_3 = "0190a000-0000-7000-8000-0000000000f3";
const ref = (id: string, position: number) => ({ position, media_id: id, alt_text: null, crop: null });
const rows = [mediaRow({ id: ID_1 }), mediaRow({ id: ID_2, file_name: "second.png" })];

interface Setup {
  media?: ReturnType<typeof ref>[];
  fit?: () => Response;
  answer?: (call: Call) => Response | undefined;
}

async function open(setup: Setup = {}) {
  const stub = stubComposerApi({
    mediaList: () => mediaPage(rows),
    medium: () => json({ data: { ...mediaRow({ id: ID_1 }), post_count: 0 } }),
    mediaFit: () => setup.fit?.() ?? mediaPage([]),
    answer: (call) => {
      if (call.method === "GET" && call.path === `posts/${POST}`) {
        return detailOf([variantRow(CH.short, "Words", { media: setup.media ?? [] })]);
      }
      return setup.answer?.(call);
    },
  });
  const opened = await openApp(`/w/w1/posts/${POST}/edit`);
  await settle();
  return { stub, ...opened };
}

const tabOf = async (at: number) => {
  await click(allById("tab-channel")[at] as HTMLElement);
  await settle();
};
const chooseFromLibrary = async (at = 0) => {
  await click(byId("media-add-library") as HTMLElement);
  await settle();
  await click(allById("library-add")[at] as HTMLElement);
  await settle();
};

describe("files from the library", () => {
  it("adds a file to the base, shows its name and state, and the type follows it", async () => {
    await open();
    await chooseFromLibrary();
    expect(byId("media-item")?.textContent).toContain("photo.png");
    expect(byId("media-state")?.textContent).toBe("Ready");
    await tabOf(0);
    expect(byId("variant-post-type")?.textContent).toContain("One image");
    expect(byId("variant-badge")?.dataset.overridden).toBe("false");
  });

  it("a file in a channel tab is that channel's own until it goes back to the base", async () => {
    await open({ media: [ref(ID_1, 0)] });
    await tabOf(0);
    await chooseFromLibrary(1);
    expect(allById("media-item")).toHaveLength(2);
    await click(byId("media-reset") as HTMLElement);
    await settle();
    expect(allById("media-item")).toHaveLength(1);
    expect(byId("media-reset")).toBeNull();
  });

  it("alt text is kept with its file", async () => {
    await open({ media: [ref(ID_1, 0)] });
    const alt = document.querySelector<HTMLInputElement>('[data-testid="media-alt"]') as HTMLInputElement;
    typeInto(alt, "A red door");
    await settle();
    expect((document.querySelector('[data-testid="media-alt"]') as HTMLInputElement).value).toBe(
      "A red door",
    );
  });
});

describe("limits and fit", () => {
  it("a channel that takes two files cannot be given a third from the library", async () => {
    await open({ media: [ref(ID_1, 0), ref(ID_2, 1)] });
    await tabOf(0);
    const add = byId("media-add-library") as HTMLElement;
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(add.getAttribute("aria-describedby") ?? "")?.textContent).toContain(
      "up to 2",
    );
  });

  it("more files than the channel takes is a check that blocks scheduling", async () => {
    await open({ media: [ref(ID_1, 0), ref(ID_2, 1), ref(ID_3, 2)] });
    expect(byId("check-issue")?.textContent).toContain("too many files for Short One");
    expect(byId("schedule-submit")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("says why a file does not fit the channel being edited", async () => {
    const fit = () =>
      json({ data: [{ channel_id: CH.short, ok: false, reason: "too_large" }], meta: { next_cursor: null } });
    await open({ media: [ref(ID_1, 0)], fit });
    await tabOf(0);
    expect(byId("media-fit")?.textContent).toContain("Short One");
    expect(byId("media-fit")?.textContent).toContain("bigger than allowed");
  });
});

describe("uploading from the composer", () => {
  // The file is hashed by the platform's own digest, which finishes outside the microtask queue, so the test waits for
  // the line the upload ends in instead of a fixed number of turns.
  async function send(file: File, endsIn: string) {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (let turn = 0; turn < 500 && byId(endsIn) === null; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  it("a file the workspace already has says so and is attached once", async () => {
    await open({
      answer: (call) =>
        call.method === "POST" && call.path === "media"
          ? json({ data: { id: ID_1, duplicate: true } }, 201)
          : undefined,
    });
    await send(new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }), "upload-duplicate");
    expect(byId("upload-duplicate")?.textContent).toContain("Already in your library");
    expect(allById("media-item")).toHaveLength(1);
  });

  it("a refused upload offers to try again and adds nothing", async () => {
    await open({
      answer: (call) =>
        call.method === "POST" && call.path === "media"
          ? json({ error: { code: "service_unavailable", message: "x", requestId: "r" } }, 503)
          : undefined,
    });
    await send(new File([new Uint8Array([1])], "photo.png", { type: "image/png" }), "upload-retry");
    expect(byId("upload-retry")).not.toBeNull();
    expect(allById("media-item")).toHaveLength(0);
  });
});
