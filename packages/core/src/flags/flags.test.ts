import { describe, expect, it } from "vitest";
import { type FlagContext, flags } from "./flags.js";

const ORG = "org-flags-1";
const WS = "ws-flags-1";

// Each row: the default, the instance, organization and workspace overrides (undefined: none) and the answer.
const CASES: [string, boolean, boolean | undefined, boolean | undefined, boolean | undefined, boolean][] = [
  ["the default when nothing overrides it (off)", false, undefined, undefined, undefined, false],
  ["the default when nothing overrides it (on)", true, undefined, undefined, undefined, true],
  ["the instance override beats the default", false, true, undefined, undefined, true],
  ["an instance override off beats a default on", true, false, undefined, undefined, false],
  ["the organization override beats the instance", false, false, true, undefined, true],
  ["an organization override off beats an instance on", true, true, false, undefined, false],
  ["the workspace override beats the organization", false, false, false, true, true],
  ["a workspace override off beats organization and instance on", true, true, true, false, false],
  ["the workspace override beats the default alone", false, undefined, undefined, true, true],
];

const context = (
  defaultOn: boolean,
  instance: boolean | undefined,
  organization: boolean | undefined,
  workspace: boolean | undefined,
): FlagContext => ({
  organizationId: ORG,
  workspaceId: WS,
  snapshot: new Map([
    [
      "flag-a",
      {
        defaultOn,
        ...(instance === undefined ? {} : { instance }),
        organizations: new Map(organization === undefined ? [] : [[ORG, organization]]),
        workspaces: new Map(workspace === undefined ? [] : [[WS, workspace]]),
      },
    ],
  ]),
});

describe("flag precedence workspace > organization > instance > default", () => {
  it.each(CASES)("%s", (_title, defaultOn, instance, organization, workspace, expected) => {
    expect(flags.isOn(context(defaultOn, instance, organization, workspace), "flag-a")).toBe(expected);
  });

  it("ignores an override that belongs to another organization or workspace", () => {
    const other: FlagContext = {
      organizationId: ORG,
      workspaceId: WS,
      snapshot: new Map([
        [
          "flag-a",
          {
            defaultOn: false,
            organizations: new Map([["org-other-1", true]]),
            workspaces: new Map([["ws-other-1", true]]),
          },
        ],
      ]),
    };
    expect(flags.isOn(other, "flag-a")).toBe(false);
  });

  it("refuses a key that is not in the snapshot", () => {
    expect(() => flags.isOn(context(false, undefined, undefined, undefined), "flag-missing")).toThrow(
      "unknown feature flag",
    );
  });
});
