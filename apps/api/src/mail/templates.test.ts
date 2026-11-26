import { describe, expect, it } from "vitest";
import { mailLocale, requestLocale, TEMPLATE_NAMES, TEMPLATES } from "./templates.js";

const LINK = "https://app.example.test/auth/verify#token=copy-1";
const FSI = String.fromCodePoint(0x2068);
const PDI = String.fromCodePoint(0x2069);
const varsOf = (name: string) =>
  name === "invitation" ? { workspaceName: "Copy Room 1", role: "editor" } : {};

describe("verify_email copy", () => {
  it("says an account was created with this address and not to open the link otherwise", () => {
    const { text } = TEMPLATES.verify_email.render("en", LINK, {});
    expect(text).toContain("An account was created with this email address");
    expect(text).toContain("do not open the link");
  });
});

describe("the Arabic copy", () => {
  it.each(TEMPLATE_NAMES)(
    "%s is its own text and keeps the link on its own line and every variable",
    (name) => {
      const en = TEMPLATES[name].render("en", LINK, varsOf(name));
      const ar = TEMPLATES[name].render("ar", LINK, varsOf(name));
      expect(ar.subject.length).toBeGreaterThan(0);
      expect([ar.subject === en.subject, ar.text === en.text]).toEqual([false, false]);
      expect(ar.text).toContain(`\n${LINK}\n`);
      expect(ar.text).toMatch(/\p{Script=Arabic}/u);
      // The role is shown as its label, which the invitation table checks.
      if (name === "invitation")
        expect([ar.subject, ar.text].every((part) => part.includes("Copy Room 1"))).toBe(true);
    },
  );
});

describe("the invitation", () => {
  const render = (locale: "en" | "ar", role: string) =>
    TEMPLATES.invitation.render(locale, LINK, { workspaceName: "Copy Room 1", role });

  it.each([
    ["en", "editor", "Editor"],
    ["ar", "editor", "محرّر"],
    ["en", "approver", "Approver"],
    ["ar", "viewer", "مشاهد"],
  ] as const)("in %s names the built-in role %s as %s", (locale, role, label) => {
    expect(render(locale, role).text).toContain(`${FSI}${label}${PDI}`);
  });

  it.each(["en", "ar"] as const)(
    "in %s shows a custom role as written and isolates it, dropping any direction mark inside it",
    (locale) => {
      expect(render(locale, "seo-lead").text).toContain(`${FSI}seo-lead${PDI}`);
      expect(render(locale, `seo${PDI}-lead`).text).toContain(`${FSI}seo-lead${PDI}`);
    },
  );

  it.each(["en", "ar"] as const)(
    "in %s isolates the workspace name in subject and text and starts the subject with no bidi mark",
    (locale) => {
      const { subject, text } = render(locale, "editor");
      expect([subject, text].every((part) => part.includes(`${FSI}Copy Room 1${PDI}`))).toBe(true);
      expect(subject).not.toMatch(/^\p{Bidi_Control}/u);
    },
  );
});

describe("the mail language", () => {
  it.each([
    ["ar", "ar"],
    ["ar-EG,en;q=0.8", "ar"],
    ["en;q=0.5, ar;q=0.9", "ar"],
    ["en-GB,ar;q=0.9", "en"],
    ["fr, de", "en"],
    ["fr, ar;q=0.3", "ar"],
    ["", "en"],
  ])("Accept-Language %j gives %s", (header, locale) => {
    expect(requestLocale(new Headers({ "accept-language": header }))).toBe(locale);
  });

  it("a request with no headers, or none at all, gives en", () => {
    expect([requestLocale(new Headers()), requestLocale(undefined)]).toEqual(["en", "en"]);
  });

  it.each([
    ["ar", "ar"],
    ["en", "en"],
    ["fr", "en"],
    ["AR", "en"],
  ])("a stored locale %s is sent as %s", (stored, locale) => {
    expect(mailLocale(stored)).toBe(locale);
  });
});
