import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Link, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";
import { request } from "../http/client";
import { safeReturnTo } from "../session/return-to";
import { Button } from "../ui/button";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { authCopy } from "./auth-copy";
import { AuthFrame, SubmitButton, useAction } from "./auth-frame";

// The server's answer to a code carries the person's name, address and verified flag, and no id.
const verified = z.object({ user: z.object({ email: z.string() }) });

/** A-04 challenge (`/mfa`): the code of the authenticator app, or a recovery code; then back to `return-to`. */
export function MfaPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);

  const verify = useAction(
    async () => {
      const path = recovery ? "/api/auth/two-factor/verify-backup-code" : "/api/auth/two-factor/verify-totp";
      await request(verified, path, { method: "POST", body: { code: code.trim() }, envelope: false });
      await navigate(safeReturnTo(params.get("return-to")));
    },
    () => setCode(""),
  );

  const failure = verify.failure;
  const expired = failure?.code === "unauthenticated" || failure?.code === "validation_failed";
  return (
    <AuthFrame title={<Trans id="auth.mfa.title">Two-step verification</Trans>}>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          void verify.run();
        }}
        className="flex flex-col gap-5"
      >
        <TextField
          label={
            recovery
              ? t({ id: "auth.mfa.recovery_label", message: "Recovery code" })
              : t({ id: "auth.mfa.code_label", message: "Authentication code" })
          }
          name="code"
          testId="mfa-code"
          autoComplete="one-time-code"
          inputMode={recovery ? "text" : "numeric"}
          isRequired
          value={code}
          onChange={setCode}
        />
        <SubmitButton testId="mfa-submit" pending={verify.pending} online={verify.online}>
          <Trans id="auth.mfa.submit">Verify</Trans>
        </SubmitButton>
      </Form>
      <div>
        <Button
          onPress={() => {
            setRecovery(!recovery);
            setCode("");
          }}
        >
          {recovery ? (
            <Trans id="auth.mfa.use_code">Use an authenticator code</Trans>
          ) : (
            <Trans id="auth.mfa.use_recovery">Use a recovery code</Trans>
          )}
        </Button>
      </div>
      {failure ? <ErrorPanel focusOnMount error={failure} {...authCopy("challenge", failure)} /> : null}
      {expired ? (
        <Link to="/sign-in" className="text-link underline">
          <Trans id="auth.mfa.start_again">Start again</Trans>
        </Link>
      ) : null}
    </AuthFrame>
  );
}
