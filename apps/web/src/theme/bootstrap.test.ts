import { afterEach, describe, expect, it, vi } from "vitest";

// The stored choice is `dark`, `light` or `system`; anything else, no value and unreadable storage all mean system.
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
