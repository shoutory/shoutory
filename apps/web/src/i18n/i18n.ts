import { i18n, type Messages } from "@lingui/core";

const LOCALES = ["en", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export type Digits = "latn" | "arab";
export type FormatPrefs = { locale: Locale; digits: Digits };

const LOCALE_KEY = "shoutory.locale";
const DIRECTION: Record<Locale, "ltr" | "rtl"> = { en: "ltr", ar: "rtl" };

const isLocale = (value: string | null | undefined): value is Locale =>
  LOCALES.some((locale) => locale === value);

// `lang` and `dir` come from this one map; components read `dir` and never test the language.
export function applyLocale(locale: Locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = DIRECTION[locale];
}

// The stored choice, else the first supported browser language (by its language subtag), else English.
export function detectLocale(stored: string | null, languages: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  for (const tag of languages) {
    const language = tag.split("-")[0]?.toLowerCase();
    if (isLocale(language)) return language;
  }
  return "en";
}

// A blocked or missing storage is a normal answer here: the browser languages decide.
export function storedLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

/** Remembers the language for the next start (the page reads it again before its first paint). */
export function storeLocale(locale: Locale) {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch (error) {
    // Blocked or full storage is a normal answer: the choice holds for this page only.
    if (!(error instanceof DOMException)) throw error;
  }
}

const catalogs = import.meta.glob<{ messages: Messages }>("../messages/*.po");

export async function activateLocale(locale: Locale) {
  const load = catalogs[`../messages/${locale}.po`];
  if (!load) throw new Error(`no message catalog for ${locale}`);
  i18n.load(locale, (await load()).messages);
  i18n.activate(locale);
  applyLocale(locale);
}

// The numbering system and the calendar are always explicit: Latin digits by default, Arabic-Indic by setting,
// and the Gregorian calendar whatever a locale's own default is.
const tagOf = ({ locale, digits }: FormatPrefs) => `${locale}-u-nu-${digits}-ca-gregory`;

export function formatNumber(value: number, prefs: FormatPrefs) {
  return new Intl.NumberFormat(tagOf(prefs)).format(value);
}

// A displayed date always names its time zone.
export function formatDate(
  date: Date,
  prefs: FormatPrefs,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "long" },
) {
  return new Intl.DateTimeFormat(tagOf(prefs), { ...options, timeZone }).format(date);
}
