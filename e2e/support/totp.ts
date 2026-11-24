import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";

const STEP_MS = 30_000;
const used = new Map<string, number>();

// The server accepts a code once per user and also the next step's code (a window of one), so a second call takes the
// next step's code instead of waiting for the clock. A third call inside the same step fails at once.
export async function nextTotp(secret: string): Promise<string> {
  const current = Math.floor(Date.now() / STEP_MS);
  const step = Math.max(current, (used.get(secret) ?? -1) + 1);
  if (step > current + 1)
    throw new Error("no unused code is accepted yet: three codes within one 30-second step");
  used.set(secret, step);
  return createOTP(base32.decode(secret)).hotp(step);
}
