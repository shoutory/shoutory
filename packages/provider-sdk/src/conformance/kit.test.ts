import { describe, expect, it } from "vitest";
import { errorResult } from "../result.js";
import { conformanceRows, type ErrorMapper } from "./kit.js";

function errorRow() {
  const row = conformanceRows.find((candidate) => candidate.id === "error-result-carries-no-id");
  if (!row) throw new Error("the kit has no error-result-carries-no-id row");
  return row;
}

const correct: ErrorMapper = ({ status, effect }) =>
  errorResult({
    effect,
    errorClass: effect === "none" ? (status === 429 ? "rate_limited" : "permanent") : "unknown",
  });

const DEFECTS: [string, ErrorMapper][] = [
  [
    "reads an id from the error body",
    ({ body, effect }) => ({
      ok: false,
      effect,
      errorClass: "permanent",
      ...((body as { id?: string } | null)?.id === undefined
        ? {}
        : { externalId: (body as { id: string }).id }),
    }),
  ],
  [
    "reports a confirmed effect on an error",
    () => ({ ok: false, effect: "confirmed", errorClass: "unknown" }),
  ],
  [
    "pairs a possible effect with a permanent class",
    ({ effect }) => ({ ok: false, effect, errorClass: "permanent" }),
  ],
];

describe("conformance kit row for error results", () => {
  it("passes for a correct error mapper", () => {
    expect(() => errorRow().run(correct)).not.toThrow();
  });

  it.each(DEFECTS)("fails for a mapper that %s", (_title, mapper) => {
    const row = errorRow();
    expect(() => row.run(mapper)).toThrow();
  });
});
