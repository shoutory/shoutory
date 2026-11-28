import { afterEach, describe, expect, it } from "vitest";
import { closeApp, openApp, settle, uuidWorkspaces } from "../../../test/support/app";
import { detailAnswer, detailTarget, POST_WS, postId, stubPostApi } from "../../../test/support/post-api";

afterEach(closeApp);

async function show(change: Record<string, unknown>, locale: "en" | "ar" = "en") {
  stubPostApi({ workspaces: uuidWorkspaces(), postDetail: () => detailAnswer([detailTarget(change)]) });
  const { host } = await openApp(`/w/${POST_WS}/posts/${postId(1)}`, locale);
  await settle();
  return host;
}
const byId = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const attempt = (change: Record<string, unknown> = {}) => ({
  attempt_no: 1,
  step: "commit",
  effect: "none",
  http_status: null,
  error_class: null,
  started_at: "2026-11-27T10:00:00.000Z",
  finished_at: "2026-11-27T10:00:05.000Z",
  ...change,
});

describe("the settings of a target", () => {
  it.each<[string, string[], string[]]>([
    ["en", ["Visibility", "Sensitive content", "Content warning"], ["spoiler_text", "spoiler text"]],
    ["ar", ["الظهور", "محتوى حساس", "تنبيه المحتوى"], ["spoiler_text", "spoiler text"]],
  ])("names each known key in %s and shows no raw key", async (locale, labels, raw) => {
    const host = await show(
      { settings: { visibility: "public", sensitive: false, spoiler_text: "" } },
      locale as "en" | "ar",
    );
    const shown = byId(host, "target-settings")?.textContent ?? "";
    for (const label of labels) expect(shown).toContain(label);
    for (const code of raw) expect(shown).not.toContain(code);
  });

  it("names a key it does not know by a plain word, never by the key", async () => {
    const host = await show({ settings: { reply_limit: 3 } });
    const shown = byId(host, "target-settings")?.textContent ?? "";
    expect(shown).toContain("Other setting");
    expect(shown).not.toContain("reply");
    expect(shown).toContain("3");
  });
});

describe("the attempts of a target", () => {
  it.each<[string, string, Record<string, unknown>, string[], string[]]>([
    [
      "a send that may have gone out",
      "en",
      { step: "commit", effect: "possible", http_status: 503, error_class: "retryable_after_send" },
      ["Sending", "may have been sent", "503", "failed after sending"],
      ["commit", "possible", "retryable_after_send"],
    ],
    [
      "a read back that confirmed",
      "en",
      { step: "read_back", effect: "confirmed" },
      ["Reading it back", "sent"],
      ["read_back", "confirmed"],
    ],
    [
      "a refused send in Arabic",
      "ar",
      { step: "commit", effect: "none", http_status: 400, error_class: "permanent" },
      ["جارٍ الإرسال", "400"],
      ["commit", "permanent"],
    ],
    [
      "a class and a step it does not know",
      "en",
      { step: "teleport", error_class: "gremlins" },
      ["Other"],
      ["teleport", "gremlins"],
    ],
  ])("%s is worded, with only the status number raw", async (_name, locale, change, words, raw) => {
    const host = await show({ evidence: [], attempts: [attempt(change)] }, locale as "en" | "ar");
    const shown = byId(host, "attempt")?.textContent ?? "";
    for (const word of words) expect(shown).toContain(word);
    for (const code of raw) expect(shown).not.toContain(code);
  });
});
