import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLocale, detectLocale } from "../i18n/i18n.js";

type Storage = string | null | "throws";
const SCRIPT = "./bootstrap.js";

async function runBootstrap(stored: Storage, prefersDark: boolean) {
  vi.stubGlobal("matchMedia", () => ({ matches: prefersDark }));
  if (stored === "throws") {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage is blocked");
      },
    });
  } else {
    localStorage.clear();
    if (stored !== null) localStorage.setItem("shoutory.theme", stored);
  }
  // The script is a plain browser script, not a module: importing it by a variable path runs it again each time.
  vi.resetModules();
  await import(/* @vite-ignore */ SCRIPT);
  return document.documentElement.dataset.theme;
}

describe("theme bootstrap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
  });

  it.each<[string, Storage, boolean, string]>([
    ["stored dark wins over a light preference", "dark", false, "dark"],
    ["stored light wins over a dark preference", "light", true, "light"],
    ["stored system follows a dark preference", "system", true, "dark"],
    ["empty storage follows a dark preference", null, true, "dark"],
    ["empty storage follows a light preference", null, false, "light"],
    ["an unknown stored value means system", "banana", true, "dark"],
    ["unreadable storage means system", "throws", true, "dark"],
  ])("%s", async (_name, stored, prefersDark, expected) => {
    expect(await runBootstrap(stored, prefersDark)).toBe(expected);
  });
});

async function pageAfter(storedLocale: Storage, languages: string[]) {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("navigator", { languages });
  if (storedLocale === "throws") {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage is blocked");
      },
    });
  } else {
    localStorage.clear();
    if (storedLocale !== null) localStorage.setItem("shoutory.locale", storedLocale);
  }
  vi.resetModules();
  await import(/* @vite-ignore */ SCRIPT);
  return { lang: document.documentElement.lang, dir: document.documentElement.dir };
}

describe("locale in the theme bootstrap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("lang");
    document.documentElement.removeAttribute("dir");
  });

  it.each<[string, Storage, string[]]>([
    ["a stored Arabic choice wins over an English browser", "ar", ["en-US"]],
    ["a stored English choice wins over an Arabic browser", "en", ["ar-EG"]],
    ["the first supported browser language decides", null, ["fr", "ar-EG", "en"]],
    ["an unsupported stored value is ignored", "xx", ["ar"]],
    ["an upper-case browser tag counts", null, ["AR-sa"]],
    ["no supported language means English", null, ["fr", "de"]],
    ["no browser languages at all means English", null, []],
    ["unreadable storage lets the browser decide", "throws", ["ar"]],
  ])("%s", async (_name, stored, languages) => {
    const actual = await pageAfter(stored, languages);
    applyLocale(detectLocale(stored === "throws" ? null : stored, languages));
    expect(actual).toEqual({ lang: document.documentElement.lang, dir: document.documentElement.dir });
    expect(actual.lang).not.toBe("");
  });
});
