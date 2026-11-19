import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import type { ApiError } from "../http/client";

export type Screen = "sign-in" | "challenge" | "step-up" | "sign-up" | "reset" | "link";
interface Words {
  what: ReactNode;
  meaning: ReactNode;
}

// The error-to-copy table: what happened and what it means, chosen by the answer's `code`, never by its
// status. The wrong-credentials copy names no lock and no time (A-01), and no answer reads Retry-After.
const TOO_MANY: Words = {
  what: <Trans id="auth.copy.too_many.what">Too many attempts</Trans>,
  meaning: <Trans id="auth.copy.too_many.meaning">Try again in a few minutes.</Trans>,
};
const UNAVAILABLE: Words = {
  what: <Trans id="auth.copy.unavailable.what">Shoutory is not reachable right now</Trans>,
  meaning: <Trans id="auth.copy.unavailable.meaning">Nothing was changed. Try again in a moment.</Trans>,
};
const EXPIRED: Words = {
  what: <Trans id="auth.copy.expired.what">Your sign-in expired</Trans>,
  meaning: <Trans id="auth.copy.expired.meaning">Start again from the sign-in page.</Trans>,
};

// A refused new password (too weak, common or breached) is told apart from a dead link by its code.
const PASSWORD_REFUSED: Words = {
  what: <Trans id="auth.copy.password_refused.what">That password is not accepted</Trans>,
  meaning: <Trans id="auth.copy.password_refused.meaning">Choose a longer or less common password.</Trans>,
};

const BY_CODE: Record<Screen, Record<string, Words>> = {
  "sign-up": { validation_failed: PASSWORD_REFUSED },
  reset: { validation_failed: PASSWORD_REFUSED },
  link: {},
  "sign-in": {
    invalid_credentials: {
      what: <Trans id="auth.copy.sign_in.what">We could not sign you in</Trans>,
      meaning: <Trans id="auth.copy.sign_in.meaning">Check your email and password, then try again.</Trans>,
    },
    email_not_verified: {
      what: <Trans id="auth.copy.unverified.what">Confirm your email first</Trans>,
      meaning: <Trans id="auth.copy.unverified.meaning">We sent you a link when you signed up.</Trans>,
    },
    password_reset_required: {
      what: <Trans id="auth.copy.breached.what">Choose a new password</Trans>,
      meaning: (
        <Trans id="auth.copy.breached.meaning">
          This password appeared in a data breach, so you need a new password.
        </Trans>
      ),
    },
  },
  challenge: {
    invalid_credentials: {
      what: <Trans id="auth.copy.wrong_code.what">That code is not right</Trans>,
      meaning: (
        <Trans id="auth.copy.wrong_code.meaning">
          Check the code in your authenticator app and try again.
        </Trans>
      ),
    },
    unauthenticated: EXPIRED,
    validation_failed: EXPIRED,
  },
  "step-up": {
    validation_failed: {
      what: <Trans id="auth.copy.wrong_password.what">That password is not right</Trans>,
      meaning: <Trans id="auth.copy.wrong_password.meaning">Check it and try again.</Trans>,
    },
    too_many_requests: {
      what: TOO_MANY.what,
      meaning: (
        <Trans id="auth.copy.lock.meaning">
          Repeated wrong passwords lock sign-in for a while. Try again in a few minutes.
        </Trans>
      ),
    },
  },
};

const GENERIC: Record<Screen, Words> = {
  "sign-up": {
    what: <Trans id="auth.copy.sign_up_failed.what">We could not create your account</Trans>,
    meaning: <Trans id="auth.copy.failed.meaning">Nothing was changed. Try again.</Trans>,
  },
  reset: {
    what: <Trans id="auth.copy.reset_failed.what">We could not set your new password</Trans>,
    meaning: <Trans id="auth.copy.failed.meaning">Nothing was changed. Try again.</Trans>,
  },
  link: {
    what: <Trans id="auth.copy.link_failed.what">We could not complete that</Trans>,
    meaning: <Trans id="auth.copy.failed.meaning">Nothing was changed. Try again.</Trans>,
  },
  "sign-in": {
    what: <Trans id="auth.copy.sign_in_failed.what">We could not sign you in</Trans>,
    meaning: <Trans id="auth.copy.failed.meaning">Nothing was changed. Try again.</Trans>,
  },
  challenge: {
    what: <Trans id="auth.copy.code_failed.what">We could not check the code</Trans>,
    meaning: <Trans id="auth.copy.failed.meaning">Nothing was changed. Try again.</Trans>,
  },
  "step-up": {
    what: <Trans id="auth.copy.password_failed.what">We could not confirm your password</Trans>,
    meaning: <Trans id="auth.copy.failed.meaning">Nothing was changed. Try again.</Trans>,
  },
};

export function authCopy(screen: Screen, error: ApiError): Words {
  const own = BY_CODE[screen][error.code];
  if (own) return own;
  if (error.code === "too_many_requests") return TOO_MANY;
  if (error.state === "maintenance") return UNAVAILABLE;
  return GENERIC[screen];
}
