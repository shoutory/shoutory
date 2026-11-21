import { createHash } from "node:crypto";
import { EgressError } from "@shoutory/provider-sdk/egress/errors";
import { describe, expect, it } from "vitest";
import type { Logger } from "../logging/logger.js";
import { createPasswordGuard } from "./hibp.js";

const CANARY = "hibp-canary-password-1";
const sha1 = createHash("sha1").update(CANARY).digest("hex").toUpperCase();

function logged() {
  const lines: string[] = [];
  const write = (fields: object, message?: string) => lines.push(JSON.stringify({ fields, message }));
  const logger: Logger = { info: write, warn: write, error: write, child: () => logger };
  return { lines, logger };
}

function guardWith(fetchRange: () => Promise<never>) {
  const { lines, logger } = logged();
  // `screen` never touches the pools.
  const pools = {} as never;
  const guard = createPasswordGuard({ fetch: fetchRange, pool: pools, appPool: pools, logger });
  return { guard, lines };
}

const refuses = (errorClass: ConstructorParameters<typeof EgressError>[0]["class"]) => async () => {
  throw new EgressError({ class: errorClass, host: "api.pwnedpasswords.com" });
};

describe("the breached-password check through the egress client", () => {
  it.each(["blocked_address", "timeout", "size_exceeded"] as const)(
    "a %s answer from the egress client means unavailable, so the password is accepted and rechecked later",
    async (errorClass) => {
      const { guard } = guardWith(refuses(errorClass));
      await expect(guard.screen(CANARY)).resolves.toBe("unavailable");
    },
  );

  it("rethrows an error that is not an EgressError instead of accepting the password", async () => {
    const { guard } = guardWith(async () => {
      throw new RangeError("a defect");
    });
    await expect(guard.screen(CANARY)).rejects.toThrow("a defect");
  });

  it("never logs the password, its hash, the range URL or the error text, only the class and the host", async () => {
    const { guard, lines } = guardWith(refuses("blocked_address"));
    await guard.screen(CANARY);
    const text = lines.join("\n");
    for (const secret of [CANARY, sha1, sha1.slice(0, 5), sha1.slice(0, 5).toLowerCase(), "/range/"])
      expect(text).not.toContain(secret);
    expect(text).toContain("blocked_address");
    expect(text).toContain("api.pwnedpasswords.com");
  });
});
