import { useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { ComboBox, Input, Label, ListBox, ListBoxItem, Popover } from "react-aria-components";
import type { Locale } from "../i18n/i18n";
import cities from "./cities.json";

const zones: Record<string, { en: string; ar: string }> = cities.zones;
const MINUTES_PER_HOUR = 60;
const ZONE_IDS = Object.keys(zones);

/** Whether `zone` is one the list names (and so one the server accepts). */
export const isKnownZone = (zone: string | null | undefined): zone is string =>
  typeof zone === "string" && Object.hasOwn(zones, zone);

const formatters = new Map<string, Intl.DateTimeFormat>();
function offsetMinutes(zone: string, at: Date): number {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" });
    formatters.set(zone, format);
  }
  const label = format.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const found = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(label);
  if (!found) return 0;
  const minutes = Number(found[2]) * MINUTES_PER_HOUR + Number(found[3] ?? 0);
  return found[1] === "-" ? -minutes : minutes;
}

/** "UTC+2", "UTC-3:30" or "UTC": the zone's offset at `at`, in Latin digits whatever the language. */
function offsetLabel(zone: string, at: Date): string {
  const total = offsetMinutes(zone, at);
  if (total === 0) return "UTC";
  const hours = Math.floor(Math.abs(total) / MINUTES_PER_HOUR);
  const minutes = Math.abs(total) % MINUTES_PER_HOUR;
  return `UTC${total < 0 ? "-" : "+"}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

// A zone whose offset differs between January and July of the year of `at` changes its clock.
function changesClock(zone: string, at: Date): boolean {
  const year = at.getUTCFullYear();
  return (
    offsetMinutes(zone, new Date(Date.UTC(year, 0, 1))) !==
    offsetMinutes(zone, new Date(Date.UTC(year, 6, 1)))
  );
}

const cityOf = (zone: string, locale: Locale) => zones[zone]?.[locale] ?? zone;

/**
 * A searchable zone list: each row is the localized city with its offset and, where the clock changes, a note; the
 * IANA id never shows (the id is only the value). The offsets are read at the clock of the moment the picker appears.
 */
export function ZonePicker({
  label,
  value,
  onChange,
  isReadOnly = false,
}: {
  label: string;
  value: string;
  onChange: (zone: string) => void;
  /** The zone is shown and cannot be changed (a role that may only read the settings). */
  isReadOnly?: boolean;
}) {
  const { i18n, t } = useLingui();
  const locale: Locale = i18n.locale === "ar" ? "ar" : "en";
  const note = t({ id: "zones.clock_changes", message: "Clocks change in summer" });
  const at = useMemo(() => new Date(), []);
  const items = useMemo(() => {
    const order = new Intl.Collator(locale);
    return ZONE_IDS.map((id) => ({ id, city: cityOf(id, locale) })).sort((a, b) =>
      order.compare(a.city, b.city),
    );
  }, [locale]);
  return (
    <ComboBox
      defaultItems={items}
      selectedKey={value}
      isReadOnly={isReadOnly}
      onSelectionChange={(key) => key !== null && onChange(String(key))}
      className="flex flex-col gap-2"
    >
      <Label className="text-sm font-medium">{label}</Label>
      <Input className="min-h-10 pointer-coarse:min-h-11 rounded-md border border-border-control bg-surface px-3 text-md" />
      <Popover className="w-(--trigger-width) rounded-md border border-border bg-surface shadow-lg">
        <ListBox className="max-h-72 overflow-auto p-2 outline-none">
          {(item: { id: string; city: string }) => (
            <ListBoxItem
              id={item.id}
              textValue={item.city}
              className="min-h-6 pointer-coarse:min-h-11 cursor-default rounded-sm px-3 py-2 outline-none data-[focused]:bg-highlight"
            >
              {item.city} (<bdi dir="ltr">{offsetLabel(item.id, at)}</bdi>)
              {changesClock(item.id, at) ? ` · ${note}` : null}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
