import { describe, expect, it } from "vitest";
import { ACCEPTED_REVISIONS, loadMigrations } from "./runner.js";

describe("the accepted revisions of applied migrations", () => {
  it("name shipped files whose current checksum is the listed new one", async () => {
    const shipped = new Map((await loadMigrations()).map(({ name, checksum }) => [name, checksum]));
    const stale = ACCEPTED_REVISIONS.filter(({ name, to }) => shipped.get(name) !== to);
    expect(stale.map(({ name }) => name)).toEqual([]);
  });

  it("list each file at most once and never from a sum to itself", () => {
    const names = ACCEPTED_REVISIONS.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(ACCEPTED_REVISIONS.filter(({ from, to }) => from === to)).toEqual([]);
  });
});
