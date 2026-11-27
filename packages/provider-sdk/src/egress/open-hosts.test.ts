import { describe, expect, it } from "vitest";
import { egressFetch } from "./client.js";
import { createOperatorPolicy, requestPolicyOf } from "./policy.js";

// A provider whose accounts live on servers a person names (a handle, a DID document, a PDS, an authorization server)
// reaches hosts nobody listed, so these rows are what keeps it on the user URL policy and away from the operator's own
// network. The address rules themselves are tested with the policy, the TXT lookup and the redirects.
const userUrl = { kind: "user_url" } as const;

const answers: Record<string, string> = {
  "handle.example.test": "169.254.169.254",
  "did.example.test": "10.0.0.5",
  "pds.example.test": "fd00::1",
  "mapped.example.test": "::ffff:10.0.0.5",
  "linklocal.example.test": "fe80::1",
  "loopback.example.test": "127.0.0.1",
};
const lookup = async (host: string) => [{ address: answers[host] ?? "93.184.216.34", family: 4 as const }];
const cloud = createOperatorPolicy({ allowCidrs: [], lookup });

describe("an open-host provider's egress (floor)", () => {
  it("uses the user URL policy and never a host list or a stored host", () => {
    expect(requestPolicyOf({ egressHostSource: "open" }, undefined)).toEqual(userUrl);
    expect(requestPolicyOf({ egressHosts: ["a.example.test"] }, undefined)).toEqual({
      kind: "provider",
      egressHosts: ["a.example.test"],
    });
    expect(requestPolicyOf({ egressHostSource: "channel" }, "social.example")).toEqual({
      kind: "instance",
      host: "social.example",
    });
    expect(requestPolicyOf({ egressHostSource: "channel" }, undefined)).toBeUndefined();
  });

  it.each(Object.keys(answers))(
    "%s resolving to a refused address is refused before any connection in the cloud",
    async (host) => {
      await expect(
        egressFetch({ url: `https://${host}/` }, { request: userUrl, operator: cloud }),
      ).rejects.toMatchObject({ class: "blocked_address" });
    },
  );
});
