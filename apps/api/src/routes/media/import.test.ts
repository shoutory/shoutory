import { EgressError, type EgressErrorClass } from "@shoutory/provider-sdk/egress/errors";
import { describe, expect, it } from "vitest";
import { fileNameOf, reasonOf } from "./import.js";

describe("the reason the member is told", () => {
  // Only the classes that no row of the route test reaches: that file reaches the blocked address, the blocked URL, the
  // invalid URL and the size, and the stalled body that times out.
  const REASONS: [EgressErrorClass, string][] = [
    ["host_not_allowed", "address_not_allowed"],
    ["too_many_redirects", "address_not_allowed"],
    ["redirect_refused", "address_not_allowed"],
    ["dns", "fetch_failed"],
    ["connect_timeout", "fetch_failed"],
    ["connect", "fetch_failed"],
    ["network", "fetch_failed"],
  ];
  it.each(REASONS)("%s is told as %s", (errorClass, reason) => {
    expect(reasonOf(new EgressError({ class: errorClass, host: "images.example" }))).toBe(reason);
  });
});

describe("the name of an imported file", () => {
  const NAMES: [string, string, string | undefined, string][] = [
    ["the last segment of the path", "https://h.example/a/photo.png", undefined, "photo.png"],
    [
      "without the query or the fragment",
      "https://h.example/a/photo.png?token=1#top",
      undefined,
      "photo.png",
    ],
    ["decoded", "https://h.example/holiday%20photo.png", undefined, "holiday photo.png"],
    ["without control characters", "https://h.example/a%00b%0A.png", undefined, "ab.png"],
    ["cut at 255 characters", `https://h.example/${"x".repeat(300)}`, undefined, "x".repeat(255)],
    ["import for a path that ends in a slash", "https://h.example/a/", undefined, "import"],
    ["import for no path", "https://h.example", undefined, "import"],
    ["import for a segment that is not valid text", "https://h.example/%E0%A4%A", undefined, "import"],
    ["the given name first", "https://h.example/a/photo.png", "mine.png", "mine.png"],
  ];
  it.each(NAMES)("is %s", (_row, url, given, name) => {
    expect(fileNameOf(url, given)).toBe(name);
  });
});
