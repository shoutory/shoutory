import { useLingui } from "@lingui/react";
import { type FormatPrefs, formatDate, formatNumber, type Locale } from "../i18n/i18n";
import { DirText } from "./dir-text";

// Latin digits whatever the language until the profile setting exists (R381, 11e adds it).
function useFormatPrefs(): FormatPrefs {
  const { i18n } = useLingui();
  return { locale: i18n.locale as Locale, digits: "latn" };
}

export function LocalizedNumber({ value }: { value: number }) {
  return <DirText dir="ltr">{formatNumber(value, useFormatPrefs())}</DirText>;
}

// A displayed date always names its time zone (AGENTS 3.10), so the zone is required and printed.
const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

export function LocalizedDateTime({ value, timeZone }: { value: Date; timeZone: string }) {
  return (
    <time dateTime={value.toISOString()}>{formatDate(value, useFormatPrefs(), timeZone, DATE_TIME)}</time>
  );
}
