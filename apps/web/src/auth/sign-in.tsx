import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
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

const answer = z.union([
  z.object({ user: z.object({ id: z.string() }) }),
  z.object({ twoFactorRedirect: z.literal(true) }),
]);
const sent = z.object({ status: z.boolean() });

function ResendLink({ email }: { email: string }) {
  const [resent, setResent] = useState(false);
  const resend = useAction(async () => {
    await request(sent, "/api/auth/send-verification-email", {
      method: "POST",
      body: { email },
      envelope: false,
    });
    setResent(true);
  });
  return (
    <div className="flex flex-col items-start gap-2">
      <Button onPress={() => void resend.run()} busy={resend.pending} aria-disabled={resend.pending}>
        <Trans id="auth.sign_in.resend">Send the link again</Trans>
      </Button>
      {resent ? (
        <p role="status">
          <Trans id="auth.sign_in.resent">We sent the link again.</Trans>
        </p>
      ) : null}
      {resend.failure ? <ErrorPanel error={resend.failure} {...authCopy("sign-in", resend.failure)} /> : null}
    </div>
  );
}

async function credentialsStep(email: string, password: string, returnTo: string | null): Promise<string> {
  const result = await request(answer, "/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
    envelope: false,
  });
  if (!("twoFactorRedirect" in result)) return safeReturnTo(returnTo);
  return returnTo === null ? "/mfa" : `/mfa?return-to=${encodeURIComponent(returnTo)}`;
}

interface Credentials {
  email: string;
  onEmail: (value: string) => void;
  password: string;
  onPassword: (value: string) => void;
}

function CredentialFields({ email, onEmail, password, onPassword }: Credentials) {
  const { t } = useLingui();
  return (
    <>
      <TextField
        label={t({ id: "auth.sign_in.email", message: "Email" })}
        name="email"
        testId="sign-in-email"
        type="email"
        autoComplete="username"
        isRequired
        value={email}
        onChange={onEmail}
      />
      <TextField
        label={t({ id: "auth.sign_in.password", message: "Password" })}
        name="password"
        testId="sign-in-password"
        type="password"
        autoComplete="current-password"
        isRequired
        value={password}
        onChange={onPassword}
      />
    </>
  );
}

export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = params.get("return-to");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = useRef<HTMLButtonElement>(null);

  const signIn = useAction(
    async () => navigate(await credentialsStep(email, password, returnTo)),
    // An unavailable server never saw the password: it stays, and Retry sends it again.
    (error) => error.state !== "maintenance" && setPassword(""),
  );

  const failure = signIn.failure;
  return (
    <AuthFrame title={<Trans id="system.sign_in.title">Sign in</Trans>}>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          void signIn.run();
        }}
        className="flex flex-col gap-5"
      >
        <CredentialFields email={email} onEmail={setEmail} password={password} onPassword={setPassword} />
        <SubmitButton testId="sign-in-submit" ref={submit} pending={signIn.pending} online={signIn.online}>
          <Trans id="auth.sign_in.submit">Sign in</Trans>
        </SubmitButton>
      </Form>
      {failure ? (
        <ErrorPanel
          focusOnMount
          error={failure}
          onRetry={() => {
            // The panel goes while Retry runs; focus waits on the submit button, not on the page.
            submit.current?.focus();
            void signIn.run();
          }}
          {...authCopy("sign-in", failure)}
        />
      ) : null}
      {failure?.code === "email_not_verified" ? <ResendLink email={email} /> : null}
      {failure?.code === "password_reset_required" ? (
        <Link to="/forgot" className="text-link underline">
          <Trans id="auth.sign_in.reset">Reset your password</Trans>
        </Link>
      ) : null}
    </AuthFrame>
  );
}
