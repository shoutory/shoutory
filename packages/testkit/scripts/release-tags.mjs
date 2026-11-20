#!/usr/bin/env node
// The image tags, the debug image tags and the channel of a release tag (v1.2.3, v1.3.0-beta.2) or of a nightly date
// (2026-11-21). Only a stable tag gives `stable`; the major tag is skipped while the major is 0, since it would move
// with every minor.
// Usage, from the repository root: node packages/testkit/scripts/release-tags.mjs <tag or date> [image name]
// It prints channel=, tags= and debug_tags= lines for $GITHUB_OUTPUT; with an image name each tag is image:tag.
// Numeric identifiers have no leading zero (semver), so v01.2.3 is not a version.
const NUMBER = "(0|[1-9]\\d*)";
const VERSION = new RegExp(`^v?${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function nightly(text) {
  const [, year, month, day] = DATE.exec(text);
  const real = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== text) {
    throw new Error(`${text} is not a date`);
  }
  return { channel: "nightly", tags: ["nightly", `nightly-${year}${month}${day}`], debugTags: [] };
}

function release(match) {
  const [, major, minor, patch, prerelease] = match;
  const exact = prerelease ? `${major}.${minor}.${patch}-${prerelease}` : `${major}.${minor}.${patch}`;
  if (prerelease) {
    // Beta is the only prerelease channel; another prerelease has no channel the image accepts.
    if (!/^beta\.(0|[1-9]\d*)$/.test(prerelease))
      throw new Error(`${exact} is a prerelease but not a beta.N`);
    return { channel: "beta", tags: [exact, "beta"], debugTags: [`${exact}-debug`, "beta-debug"] };
  }
  const moving = major === "0" ? [`${major}.${minor}`] : [`${major}.${minor}`, major];
  return { channel: "stable", tags: [exact, ...moving, "stable"], debugTags: [`${exact}-debug`] };
}

export function imageTags(text) {
  if (DATE.test(text)) return nightly(text);
  const match = VERSION.exec(text);
  if (!match) throw new Error(`${JSON.stringify(text)} is neither a release tag nor a date`);
  return release(match);
}

if (import.meta.main) {
  const [input = "", image] = process.argv.slice(2);
  const { channel, tags, debugTags } = imageTags(input);
  const named = (list) => list.map((tag) => (image ? `${image}:${tag}` : tag)).join(",");
  console.log(`channel=${channel}`);
  console.log(`tags=${named(tags)}`);
  console.log(`debug_tags=${named(debugTags)}`);
}
