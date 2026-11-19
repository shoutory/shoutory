#!/usr/bin/env node
// Writes `src/zones/cities.json`: for every time zone the server accepts, its city in English and Arabic, from the CLDR
// exemplar cities (`Intl` does not expose them). Only the English and Arabic files are read. A zone with no exemplar
// city takes the last segment of its id, underscores as spaces, in both languages. Run from `apps/web`:
//   node scripts/generate-zones.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dates = join(root, "node_modules", "cldr-dates-full");

// `zone` nests by the id's segments (`Africa` > `Cairo`); a leaf is the object that holds `exemplarCity`.
function cityNames(locale) {
  const file = join(dates, "main", locale, "timeZoneNames.json");
  const { zone } = JSON.parse(readFileSync(file, "utf8")).main[locale].dates.timeZoneNames;
  const found = new Map();
  const walk = (node, path) => {
    if (typeof node.exemplarCity === "string") found.set(path.join("/"), node.exemplarCity);
    for (const [key, child] of Object.entries(node)) {
      if (child && typeof child === "object") walk(child, [...path, key]);
    }
  };
  walk(zone, []);
  return found;
}

// The licence's own copyright line and permission text, as the data's licence asks them to travel with the data.
function notice() {
  const text = readFileSync(join(dates, "LICENSE"), "utf8");
  const marker = "All other content in this repo is released under UNICODE LICENSE V3";
  const copyright = /Copyright © [^\n]+/.exec(text)?.[0] ?? "";
  return `${copyright}\n\n${text.slice(text.indexOf(marker) + marker.length).trim()}`;
}

const lastSegment = (id) => id.split("/").at(-1).replaceAll("_", " ");
const english = cityNames("en");
const arabic = cityNames("ar");
const ids = [...new Set([...Intl.supportedValuesOf("timeZone"), "UTC"])].sort();
const zones = Object.fromEntries(
  ids.map((id) => [id, { en: english.get(id) ?? lastSegment(id), ar: arabic.get(id) ?? lastSegment(id) }]),
);
const out = join(root, "src", "zones", "cities.json");
writeFileSync(out, `${JSON.stringify({ notice: notice(), zones }, null, 2)}\n`);
console.log(`${ids.length} zones written to ${out}`);
