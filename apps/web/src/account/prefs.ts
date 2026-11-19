import { useSyncExternalStore } from "react";
import type { Digits } from "../i18n/i18n";

// The theme and the digits stay in this browser: the keys are the ones the page reads at start-up (the theme before
// first paint, in theme/bootstrap.js).
const THEME_KEY = "shoutory.theme";
const DIGITS_KEY = "shoutory.digits";

export type Theme = "system" | "light" | "dark";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // blocked storage is a normal answer: the defaults hold
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // Blocked or full storage is a normal answer: the choice holds for this page only.
    if (!(error instanceof DOMException)) throw error;
  }
}

export function readTheme(): Theme {
  const stored = read(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Stores the theme and applies it now: `system` follows the browser's preference, as the start-up script does. */
export function setTheme(theme: Theme) {
  write(THEME_KEY, theme);
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

const listeners = new Set<() => void>();

export const readDigits = (): Digits => (read(DIGITS_KEY) === "arab" ? "arab" : "latn");

export function setDigits(digits: Digits) {
  write(DIGITS_KEY, digits);
  for (const listener of listeners) listener();
}

/** The digits setting; every number on screen follows a change at once. */
export function useDigits(): Digits {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, readDigits);
}
