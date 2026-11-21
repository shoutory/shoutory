import { describe, expect, it } from "vitest";
import { TEMPLATES } from "./templates.js";

describe("verify_email copy (R492)", () => {
  it("says an account was created with this address and not to open the link otherwise", () => {
    const { text } = TEMPLATES.verify_email.render("https://app.example.test/auth/verify#token=copy-1", {});
    expect(text).toContain("An account was created with this email address");
    expect(text).toContain("do not open the link");
  });
});
