import { afterEach, describe, expect, it } from "vitest";
import { channelPage, click, closeApp, openApp, roleOf, settle } from "../../../test/support/app";
import {
  allById,
  BROKEN,
  byId,
  CH,
  CHANNELS,
  field,
  stubComposerApi,
  typeInto,
} from "../../../test/support/composer-api";

afterEach(closeApp);

async function open(api: Parameters<typeof stubComposerApi>[0] = {}, locale: "en" | "ar" = "en") {
  const stub = stubComposerApi(api);
  const opened = await openApp("/w/w1/posts/new", locale);
  await settle();
  return { stub, ...opened };
}

const pick = async (...ids: string[]) => {
  for (const id of ids) {
    const row = allById("picker-channel").find((label) => label.querySelector(`input`)?.value === id);
    await click(row as HTMLElement);
  }
  await settle();
};

const write = async (text: string) => {
  typeInto(field("composer-base"), text);
  await settle();
};

describe("channels and counters", () => {
  it("four channels each show their own counter for the same text", async () => {
    await open();
    await pick(CH.short, CH.bytes, CH.weighted, CH.thread);
    await write("Hello there");
    const counters = [CH.short, CH.bytes, CH.weighted, CH.thread].map(
      (id) => byId(`counter-${id}`)?.textContent,
    );
    expect(counters[0]).toContain("11 of 20");
    expect(counters[1]).toContain("11 of 30 bytes");
    expect(counters[2]).toContain("11 of 10");
    expect(counters[2]).toContain("1 over");
    expect(counters[3]).toContain("11 of 280");
  });

  it.each([
    ["graphemes", CH.short, "áb́", "2 of 20"],
    ["utf-8 bytes", CH.bytes, "مرحبا", "10 of 30 bytes"],
    ["weighted Arabic", CH.weighted, "مرحبا", "10 of 10"],
    ["a link at its fixed weight", CH.weighted, "https://example.test/a-long-address", "23 of 10"],
  ])("counts %s as the shared rule does", async (_name, channel, text, words) => {
    await open();
    await pick(channel);
    await write(text);
    expect(byId(`counter-${channel}`)?.textContent).toContain(words);
  });

  it("text over a limit says by how much and blocks with a link to the field", async () => {
    await open();
    await pick(CH.short);
    await write("x".repeat(32));
    expect(byId(`counter-${CH.short}-over`)?.textContent).toBe("12 over");
    const issue = byId("check-issue");
    expect(issue?.textContent).toContain("12 over");
    await click(byId("check-go") as HTMLElement);
    await settle();
    expect(document.activeElement).toBe(field("composer-base"));
  });
});

describe("variants", () => {
  it("a channel tab follows the base until it is typed in, and reset returns to the base", async () => {
    await open();
    await pick(CH.short);
    await write("Base words");
    await click(byId("tab-channel") as HTMLElement);
    await settle();
    expect(byId("variant-badge")?.dataset.overridden).toBe("false");
    expect(field("composer-variant-text").value).toBe("Base words");
    typeInto(field("composer-variant-text"), "Own words");
    await settle();
    expect(byId("variant-badge")?.dataset.overridden).toBe("true");
    await click(byId("variant-reset") as HTMLElement);
    await settle();
    expect(field("composer-variant-text").value).toBe("Base words");
  });

  it("the post type list holds only what the channel's provider takes", async () => {
    await open();
    await pick(CH.short);
    await click(byId("tab-channel") as HTMLElement);
    await settle();
    await click(byId("variant-post-type") as HTMLElement);
    const options = [...document.body.querySelectorAll('[role="option"]')].map((one) => one.textContent);
    expect(options).toEqual(["Text", "One image", "Several images"]);
  });
});

describe("the picker", () => {
  it("a channel that needs reconnecting says so and can still be picked for a draft", async () => {
    await open({ channelList: () => channelPage([...CHANNELS, BROKEN], null, []) });
    expect(byId("picker-reconnect")?.textContent).toContain("Reconnect needed");
    await pick(CH.broken);
    expect(allById("tab-channel")).toHaveLength(1);
  });

  it("select all picks every channel and a second press clears them", async () => {
    await open();
    await click(byId("picker-all") as HTMLElement);
    await settle();
    expect(allById("tab-channel")).toHaveLength(4);
    await click(byId("picker-all") as HTMLElement);
    await settle();
    expect(allById("tab-channel")).toHaveLength(0);
  });

  it("a workspace with no channel offers to connect one", async () => {
    await open({ channelList: () => channelPage([], null, []) });
    expect(byId("picker-connect")).not.toBeNull();
  });
});

describe("who may edit", () => {
  it.each(["viewer", "approver"])("%s sees the composer read-only with the reason", async (role) => {
    await open({ workspaces: roleOf(role) });
    expect(byId("composer-readonly")?.textContent).toContain("View only");
    expect(field("composer-base").readOnly).toBe(true);
  });
});

describe("Arabic", () => {
  it("keeps the counter right and lets the text decide its own direction", async () => {
    await open({}, "ar");
    await pick(CH.weighted);
    await write("مرحبا");
    expect(field("composer-base").getAttribute("dir")).toBe("auto");
    expect(byId(`counter-${CH.weighted}`)?.textContent).toContain("10");
    expect(byId("composer-base")).not.toBeNull();
  });
});
