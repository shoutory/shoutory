import { describe, expect, it } from "vitest";
import { errorResult } from "../result.js";
import { faultMatrixRows } from "./fault-matrix.js";
import { conformanceRows, type ErrorMapper } from "./kit.js";

const manifest = {
  absentAnswers: [{ status: 404 }],
  capabilities: ["text", "delete"],
  retryAfterMaxSeconds: 900,
  readBackMode: "A",
} as const;

describe("the fault matrix reads its profile from the manifest", () => {
  const ids = (capabilities: readonly string[]) =>
    faultMatrixRows({
      manifest: { ...manifest, capabilities },
      badRequestCodes: [],
      revokedCode: "revoked",
    }).map((row) => row.id);

  it("plays the rows of each declared capability and none of an undeclared one", () => {
    expect(ids(["edit", "thread", "first_comment"])).toEqual(
      expect.arrayContaining(["edit-published-post", "thread-parts-in-order", "first-comment"]),
    );
    expect(ids(["text"])).not.toContain("edit-published-post");
  });

  it("refuses a manifest that declares a capability the matrix has no row for", () => {
    // fails first because: the profile was typed by hand, so a declared capability could be left out unnoticed
    expect(() => ids(["text", "teleport"])).toThrow(/no row.*teleport/);
  });

  it.each([
    ["an exempt capability", ["text", "image", "refresh"], undefined],
    ["a declared video with no row", ["text", "video"], /no row.*video/],
    ["a declared link_card with no row", ["text", "link_card"], /no row.*link_card/],
  ])("%s", (_title, capabilities, error) => {
    if (error) expect(() => ids(capabilities)).toThrow(error);
    else expect(() => ids(capabilities)).not.toThrow();
  });
});

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
