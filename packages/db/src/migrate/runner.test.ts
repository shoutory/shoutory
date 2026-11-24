import { describe, expect, it } from "vitest";
import { ACCEPTED_REVISIONS, loadMigrations } from "./runner.js";

describe("the accepted revisions of applied migrations", () => {
  it("name shipped files whose current checksum is the listed new one", async () => {
    const shipped = new Map((await loadMigrations()).map(({ name, checksum }) => [name, checksum]));
    const stale = ACCEPTED_REVISIONS.filter(({ name, to }) => shipped.get(name) !== to);
    expect(stale.map(({ name }) => name)).toEqual([]);
  });

  it("list each file and old sum at most once and never from a sum to itself", () => {
    const pairs = ACCEPTED_REVISIONS.map(({ name, from }) => `${name} ${from}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(ACCEPTED_REVISIONS.filter(({ from, to }) => from === to)).toEqual([]);
  });
});
