import { describe, expect, it } from "vitest";
import { isStorageKey, MAX_KEY_BYTES, MAX_KEY_SEGMENTS } from "./storage.js";

const VALID = [
  "a",
  "media/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  ".shoutory-check/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  "users/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/avatar.webp",
  "a.b_c-D/9",
  Array.from({ length: MAX_KEY_SEGMENTS }, () => "s").join("/"),
  "k".repeat(MAX_KEY_BYTES),
];

const INVALID: [string, string][] = [
  ["empty", ""],
  ["dot-dot segment", "../x"],
  ["dot-dot in the middle", "a/../../b"],
  ["dot segment", "a/./b"],
  ["absolute path", "/abs"],
  ["trailing slash", "a/"],
  ["empty segment", "a//b"],
  ["backslash", "a\\b"],
  ["NUL", "a\u0000b"],
  ["space", "a b"],
  ["percent sign", "a%2e%2e/b"],
  ["non-ASCII letter", "café"],
  ["too many segments", Array.from({ length: MAX_KEY_SEGMENTS + 1 }, () => "s").join("/")],
  ["too long", "k".repeat(MAX_KEY_BYTES + 1)],
];

describe("storage key validator", () => {
  it.each(VALID.map((key) => [key.slice(0, 40), key]))("accepts %s", (_label, key) => {
    expect(isStorageKey(key)).toBe(true);
  });

  it.each(INVALID)("refuses %s", (_label, key) => {
    expect(isStorageKey(key)).toBe(false);
  });
});
