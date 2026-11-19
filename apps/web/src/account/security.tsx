import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { ChangePassword } from "./change-password";
import { Sessions } from "./sessions";
import { TwoFactorBlock } from "./two-factor-block";

/** A-07 (`/account/security`): the password, two-step verification and the devices signed in as this person. */
export function SecurityPage() {
  // A password change ends the other sessions: the device list is keyed by this count and read again when it changes.
  const [changes, setChanges] = useState(0);
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="account.security.title">Security</Trans>
      </h1>
      <ChangePassword onChanged={() => setChanges((now) => now + 1)} />
      <TwoFactorBlock />
      <Sessions key={changes} />
    </>
  );
}
