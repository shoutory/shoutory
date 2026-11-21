import { EgressError, wrapNetworkError } from "./errors.js";
import type { OperatorPolicy } from "./policy.js";

const MAX_NAME_LENGTH = 253;
const MAX_RECORDS = 16;
const MAX_TOTAL_CHARS = 4096;
// At least two DNS labels of letters, digits, `_` and `-`: no IP literal, no single label such as `localhost`.
const NAME = /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9]$/;

/**
 * The TXT records of a DNS name (the `_atproto` handle lookup). A TXT answer is data, never an address, so only the
 * queried name is checked; the resolver is bounded by a timeout and a try count, and the answer is capped at 16 records and 4 KiB. A failure is an `EgressError`.
 */
export async function egressResolveTxt(name: string, operator: OperatorPolicy): Promise<string[]> {
  if (name.length > MAX_NAME_LENGTH || !NAME.test(name))
    throw new EgressError({ class: "invalid_url", host: "" });
  try {
    const records = (await operator.resolveTxt(name)).map((chunks) => chunks.join(""));
    const total = records.reduce((sum, record) => sum + record.length, 0);
    if (records.length > MAX_RECORDS || total > MAX_TOTAL_CHARS) {
      throw new EgressError({ class: "size_exceeded", host: name });
    }
    return records;
  } catch (error) {
    throw wrapNetworkError(error, name);
  }
}
