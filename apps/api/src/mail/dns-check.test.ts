import { describe, expect, it } from "vitest";
import { mailCheckCommand, type TxtResolver } from "../cli/mail-check.js";
import { checkMailDns, describeRecord } from "./dns-check.js";

const FROM = "Shoutory <noreply@mail.example.test>";
const RECORDS: Record<string, string[][]> = {
  "mail.example.test": [["v=spf1 include:_spf.example.test -all"]],
  "_dmarc.mail.example.test": [["v=DMARC1; p=none"]],
  "s1._domainkey.mail.example.test": [["v=DKIM1; k=rsa; p=", "AAAA"]],
};
// A name the zone does not hold rejects the way the system resolver does; any other code is a failed lookup.
const resolverWith =
  (present: string[], code = "ENOTFOUND"): TxtResolver =>
  async (name) => {
    const found = present.includes(name) ? RECORDS[name] : undefined;
    if (!found) throw Object.assign(new Error(`queryTxt ${code} ${name}`), { code });
    return found;
  };

describe("the shared mail check", () => {
  it.each([
    ["all three present", Object.keys(RECORDS), "ENOTFOUND", "s1"],
    ["all three missing", [], "ENOTFOUND", "s1"],
    ["DKIM missing only", ["mail.example.test", "_dmarc.mail.example.test"], "ENOTFOUND", "s1"],
    ["lookups that fail", [], "ETIMEOUT", "s1"],
    ["no selector", Object.keys(RECORDS), "ENOTFOUND", undefined],
  ])(
    "returns the same SPF, DMARC and DKIM result the CLI prints (%s)",
    async (_name, present, code, selector) => {
      const resolve = resolverWith(present, code);
      const shared = await checkMailDns({ from: FROM, dkimSelector: selector }, resolve);
      const printed: string[] = [];
      await mailCheckCommand(
        {
          SHOUTORY_MAIL_FROM: FROM,
          ...(selector ? { SHOUTORY_MAIL_DKIM_SELECTOR: selector } : {}),
        },
        { stdout: (line) => printed.push(line), stderr: () => undefined },
        resolve,
      );
      expect(shared.domain).toBe("mail.example.test");
      expect(shared.records.map(describeRecord)).toEqual(printed);
    },
  );

  // The lookups are independent, so they run together: the call waits for one lookup's timeout, not three.
  it("looks the three names up together and keeps the order SPF, DMARC, DKIM", async () => {
    let active = 0;
    let most = 0;
    const slow: TxtResolver = async (name) => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return RECORDS[name] ?? [];
    };
    const { records } = await checkMailDns({ from: FROM, dkimSelector: "s1" }, slow);
    expect(most).toBe(3);
    expect(records.map((record) => record.kind)).toEqual(["SPF", "DMARC", "DKIM"]);
  });

  it("answers no domain and no records when there is no sender, and looks nothing up", async () => {
    let lookups = 0;
    const counting: TxtResolver = async () => {
      lookups += 1;
      return [];
    };
    expect(await checkMailDns({ from: undefined, dkimSelector: undefined }, counting)).toEqual({
      domain: undefined,
      records: [],
    });
    expect(lookups).toBe(0);
  });
});
