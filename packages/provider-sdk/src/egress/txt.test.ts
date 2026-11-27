import { describe, expect, it } from "vitest";
import { EgressError } from "./errors.js";
import { createOperatorPolicy } from "./policy.js";
import { egressResolveTxt } from "./txt.js";

const withAnswer = (resolveTxt: (name: string) => Promise<string[][]>) =>
  createOperatorPolicy({ allowCidrs: [], resolveTxt });

describe("egressResolveTxt (the _atproto lookup)", () => {
  it.each([
    ["an IP literal", "127.0.0.1"],
    ["a bracketed IPv6 literal", "[::1]"],
    ["a private IPv4 literal", "10.0.0.1"],
    ["the metadata address", "169.254.169.254"],
    ["a single label", "localhost"],
    ["an empty name", ""],
    ["a name over 253 characters", `${`${"a".repeat(60)}.`.repeat(5)}example.com`],
    ["a name with a URL character", "_atproto.example.com/path"],
  ])("refuses %s before any query", async (_name, name) => {
    let asked = 0;
    const policy = withAnswer(async () => {
      asked += 1;
      return [["did=1"]];
    });
    await expect(egressResolveTxt(name, policy)).rejects.toBeInstanceOf(EgressError);
    expect(asked).toBe(0);
  });

  it("joins the chunks of each record and returns data, never an address check", async () => {
    const policy = withAnswer(async () => [["did:plc:", "abc123"], ["other"]]);
    await expect(egressResolveTxt("_atproto.example.com", policy)).resolves.toEqual([
      "did:plc:abc123",
      "other",
    ]);
  });

  it.each([
    ["more than 16 records", Array.from({ length: 17 }, () => ["did=1"])],
    ["more than 4 KiB in total", [["a".repeat(3000)], ["b".repeat(1200)]]],
  ])("an answer with %s is cut as size_exceeded", async (_name, records) => {
    const failure = await egressResolveTxt(
      "_atproto.example.com",
      withAnswer(async () => records),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EgressError);
    expect((failure as EgressError).class).toBe("size_exceeded");
  });

  it.each(["ENOTFOUND", "ENODATA", "ETIMEOUT", "ESERVFAIL"])(
    "a %s lookup is an EgressError of class dns with no effect that holds no part of the original",
    async (code) => {
      const policy = withAnswer(async () => {
        throw Object.assign(new Error("queryTxt failed _atproto.example.com?token=txt-canary-1"), { code });
      });
      const failure = await egressResolveTxt("_atproto.example.com", policy).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(EgressError);
      expect([(failure as EgressError).class, (failure as EgressError).effect]).toEqual(["dns", "none"]);
      expect(`${String(failure)}${(failure as Error).stack}`).not.toContain("txt-canary-1");
    },
  );
});
