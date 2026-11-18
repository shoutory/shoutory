import { describe, expect, it } from "vitest";
import { isCommonPassword, passwordPolicy } from "./policy.js";

describe("the password policy", () => {
  it.each([
    ["14 characters", "a".repeat(14), false],
    ["15 characters", "correct-horse-1", true],
    ["128 characters", `${"x7".repeat(63)}ab`, true],
    ["129 characters", `${"x7".repeat(63)}abc`, false],
    ["15 code points of astral characters", "😀".repeat(15), true],
    ["129 code points of astral characters", "😀".repeat(129), false],
    ["a common word with digits and symbols around it", "Password1!!!!!!!!!!!", false],
    ["a repetition of one common word", "passwordpassword1", false],
    ["a common word alone, long enough by repetition", "qwertyqwertyqwerty", false],
  ])("%s", (_name, password, accepted) => {
    expect(passwordPolicy.safeParse(password).success).toBe(accepted);
  });

  it.each([
    ["Password", true],
    ["  123456  ", true],
    ["monkey2024", true],
    ["a-long-uncommon-pass", false],
    ["", false],
  ])("the common list: %j is common = %s", (password, common) => {
    expect(isCommonPassword(password)).toBe(common);
  });

  it("a fullwidth form of a list entry is refused: the list is matched after NFKC", () => {
    expect(isCommonPassword("ｐａｓｓｗｏｒｄ")).toBe(true);
  });

  it("a 1 MiB value is refused with the length issue only, before any list work", () => {
    const result = passwordPolicy.safeParse("password".repeat(131_072));
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "The password must be 15 to 128 characters.",
    ]);
  });
});
