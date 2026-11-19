import { describe, expect, it } from "vitest";
import { mailCheckCommand, type TxtResolver } from "./mail-check.js";

const ENV = {
  SHOUTORY_MAIL_FROM: "Shoutory <noreply@mail.example.test>",
  SHOUTORY_MAIL_DKIM_SELECTOR: "s1",
};
const RECORDS: Record<string, string[][]> = {
  "mail.example.test": [["v=spf1 include:_spf.example.test -all"]],
  "_dmarc.mail.example.test": [["v=DMARC1; p=none"]],
  "s1._domainkey.mail.example.test": [["v=DKIM1; k=rsa; p=", "AAAA"]],
};
// A name the zone does not hold rejects the way the system resolver does.
const resolverWith =
  (present: string[]): TxtResolver =>
  async (name) => {
    const found = present.includes(name) ? RECORDS[name] : undefined;
    if (!found) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return found;
  };

describe("shoutory mail check", () => {
  it.each([
    ["all three present", Object.keys(RECORDS), { SPF: "present", DMARC: "present", DKIM: "present" }],
    ["all three missing", [], { SPF: "missing", DMARC: "missing", DKIM: "missing" }],
    [
      "DKIM missing only",
      ["mail.example.test", "_dmarc.mail.example.test"],
      { SPF: "present", DMARC: "present", DKIM: "missing" },
    ],
  ])("reports SPF, DMARC and DKIM from the resolver (%s) and exits 0", async (_name, present, expected) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await mailCheckCommand(
      ENV,
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
      resolverWith(present),
    );
    expect(code).toBe(0);
    for (const [record, state] of Object.entries(expected)) {
      expect(
        out.some((line) => line.startsWith(`${record}: ${state}`)),
        `${record} ${state}`,
      ).toBe(true);
    }
  });

  it("prints 'DKIM: not checked (no selector)' and exits 0 when no selector is set", async () => {
    const out: string[] = [];
    const { SHOUTORY_MAIL_DKIM_SELECTOR: _selector, ...noSelector } = ENV;
    const io = { stdout: (line: string) => out.push(line), stderr: () => undefined };
    expect(await mailCheckCommand(noSelector, io, resolverWith(Object.keys(RECORDS)))).toBe(0);
    expect(out).toContain("DKIM: not checked (no selector)");
    expect(out.some((line) => line.startsWith("SPF: present"))).toBe(true);
  });
});
