import { SealedSecret } from "@shoutory/core/crypto";
import { describe, expect, it } from "vitest";
import { createMastodonAdapter } from "./adapter.js";

const account = { accessToken: new SealedSecret("token-for-goldens"), instanceHost: "social.example" };

// The instance, not the adapter, turns text into a status: what the person wrote must arrive as it was written.
describe("the text of a post reaches the instance byte for byte", () => {
  it.each([
    ["Markdown is not rendered", "**bold** _em_ `code`\n- item\n\n> quote"],
    ["a link keeps its query and fragment", "see https://example.com/a?b=1&c=%20d#frag now"],
    ["mentions and hashtags", "hi @user and @other@example.social #tag #وسم"],
    [
      "emoji, a joined sequence and a variation selector",
      "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} ❤️ :custom:",
    ],
    ["Arabic text with a bidirectional mark and a digit", "مرحبا بالعالم ‏ 123 ١٢٣"],
    ["leading and trailing space and a blank line", "  spaced  \n\n"],
  ])("%s", async (_name, text) => {
    let sent: unknown;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ id: "1090000000000001" });
    };
    const answer = await createMastodonAdapter().commit(
      { fetch, now: () => new Date("2026-11-27T00:00:00Z") },
      { idempotencyKey: "golden-1", text, account },
    );
    expect(answer.ok).toBe(true);
    expect(sent).toMatchObject({ status: text });
  });
});
