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

describe("the notice mail copy", () => {
  const VARS = { name: "Shop Page 1", days: 7 };
  // [template, the level of its mail, the words that must differ in meaning between the levels]
  const CASES = [
    ["token_expiry", "7d"],
    ["reconnect_deadline", "7d"],
    ["needs_human", "escalation_0"],
    ["unverified", "escalation_2"],
    ["held_media", "held"],
    ["drafts_day_30", "30d"],
  ] as const;

  it.each(CASES)("%s is its own text in both languages, has no link and names the channel", (name, level) => {
    const vars = { ...VARS, level };
    const en = TEMPLATES[name].render("en", "", vars);
    const ar = TEMPLATES[name].render("ar", "", vars);
    expect(TEMPLATES[name].sealedLink).toBe(false);
    expect([ar.subject === en.subject, ar.text === en.text]).toEqual([false, false]);
    expect(`${ar.subject}${ar.text}`).toMatch(/\p{Script=Arabic}/u);
    expect(`${en.subject}${en.text}`).not.toMatch(/\p{Script=Arabic}/u);
    for (const part of [en.subject, en.text, ar.subject, ar.text]) expect(part).not.toMatch(/https?:/);
    for (const text of [en.text, ar.text]) expect(text).toContain(`${FSI}Shop Page 1${PDI}`);
    expect(en.subject).not.toMatch(/^\p{Bidi_Control}/u);
  });

  it.each([
    ["token_expiry", 14, "14 days", "14 يوماً"],
    ["token_expiry", 1, "1 day", "يوم واحد"],
    ["reconnect_deadline", 7, "7 days", "7 أيام"],
  ] as const)("%s with %i days says the number in both languages", (name, days, en, ar) => {
    const vars = { name: "Shop Page 1", days, level: `${days}d` };
    expect(TEMPLATES[name].render("en", "", vars).text).toContain(en);
    expect(TEMPLATES[name].render("ar", "", vars).text).toContain(ar);
  });

  it.each(CASES)("%s refuses a token, a link or any key the copy does not know", (name, level) => {
    const schema = TEMPLATES[name].vars;
    expect(schema.safeParse({ level, name: "Shop" }).success).toBe(true);
    expect(schema.safeParse({ level, name: "Shop", access_token: "copy-token-1" }).success).toBe(false);
    expect(schema.safeParse({ level, link: "https://app.example.test/x" }).success).toBe(false);
    expect(schema.safeParse({ name: "Shop" }).success).toBe(false);
  });

  it("the escalation says it is a reminder after the first step and the first notice does not", () => {
    const first = TEMPLATES.needs_human.render("en", "", { level: "escalation_0", name: "Shop" });
    const later = TEMPLATES.needs_human.render("en", "", { level: "escalation_3", name: "Shop" });
    expect([
      first.subject === later.subject,
      /reminder/i.test(first.subject),
      /reminder/i.test(later.subject),
    ]).toEqual([false, false, true]);
  });
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
