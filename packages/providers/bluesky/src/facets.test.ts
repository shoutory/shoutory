import { describe, expect, it } from "vitest";
import { detectFacets } from "./facets.js";

const DID = "did:plc:alicealicealicealicealic";
const resolve = async (handle: string) => (handle === "alice.example" ? DID : undefined);

// The offsets are counted by hand: Arabic letters are 2 bytes, an emoji 4, a joined family of three 18, a space 1.
describe("facets index the text in UTF-8 bytes", () => {
  it.each([
    ["a link after Arabic text", "مرحبا https://example.com/a?b=1 end", 11, 36],
    ["a link after an emoji", "😀😀 https://example.com/x", 9, 30],
    ["a hashtag in Arabic", "x #وسم y", 2, 9],
    ["a mention after a joined emoji", "👨‍👩‍👧 @alice.example hi", 19, 33],
  ])("%s", async (_name, text, byteStart, byteEnd) => {
    const [facet] = await detectFacets(text, resolve);
    expect(facet?.index).toEqual({ byteStart, byteEnd });
  });
});

describe("the handles of mentions are looked up sparingly", () => {
  const counting = () => {
    const asked: string[] = [];
    const resolveAny = async (handle: string) => {
      asked.push(handle);
      return DID;
    };
    return { asked, resolveAny };
  };

  it("a handle repeated in a post is resolved once and every mention of it is marked", async () => {
    const { asked, resolveAny } = counting();
    const facets = await detectFacets("@alice.example hi @alice.example and @Alice.example", resolveAny);
    expect(asked).toEqual(["alice.example"]);
    expect(facets).toHaveLength(3);
  });

  it("at most ten distinct handles are resolved and the mentions beyond them stay text", async () => {
    const { asked, resolveAny } = counting();
    const text = Array.from({ length: 12 }, (_, index) => `@person${index}.example`).join(" ");
    const facets = await detectFacets(text, resolveAny);
    expect(asked).toHaveLength(10);
    expect(facets).toHaveLength(10);
  });
});

describe("facet goldens: links, mentions and tags are marked and the text is never changed", () => {
  it.each([
    [
      "a link keeps its query and drops the punctuation that ends the sentence",
      "see https://example.com/a?b=1&c=2.",
      [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/a?b=1&c=2" }],
    ],
    [
      "a link keeps the closing parenthesis that matches its own opening one",
      "see https://en.wikipedia.org/wiki/Foo_(bar) now",
      [{ $type: "app.bsky.richtext.facet#link", uri: "https://en.wikipedia.org/wiki/Foo_(bar)" }],
    ],
    [
      "a link drops a closing parenthesis that closes the text around it",
      "(see https://example.com/a) and https://example.com/b).",
      [
        { $type: "app.bsky.richtext.facet#link", uri: "https://example.com/a" },
        { $type: "app.bsky.richtext.facet#link", uri: "https://example.com/b" },
      ],
    ],
    [
      "a resolved mention names the DID",
      "hi @alice.example!",
      [{ $type: "app.bsky.richtext.facet#mention", did: DID }],
    ],
    ["a mention nobody has stays plain text", "hi @nobody.example", []],
    [
      "a tag stops before closing punctuation",
      "good #morning, all",
      [{ $type: "app.bsky.richtext.facet#tag", tag: "morning" }],
    ],
    ["a number sign followed by digits is no tag", "item #123", []],
    ["an address inside a word is no mention", "mail me@alice.example", []],
    ["markdown is not rendered", "**bold** `code` - item", []],
  ])("%s", async (_name, text, features) => {
    const facets = await detectFacets(text, resolve);
    expect(facets.flatMap((facet) => facet.features)).toEqual(features);
  });
});
