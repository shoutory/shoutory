import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { Form } from "react-aria-components";
import { Link } from "react-router";
import { z } from "zod";
import { ApiError, request } from "../http/client";
import { Banner } from "../ui/banner";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { authCopy } from "./auth-copy";
import { AuthFrame, SubmitButton, useAction } from "./auth-frame";
import { NewPasswordField, useNewPassword } from "./new-password";

const mode = z.object({ open: z.boolean() });
// The answer is alike for a new, a known and a closed address, so only its shape is checked.
const created = z.object({ user: z.object({ emailVerified: z.boolean() }) });

/** Whether the operator closed sign-up. A failed read is a normal answer: the form stays, the server decides. */
function useInvitationOnly(): boolean {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    let current = true;
    request(mode, "/api/v1/instance/signup").then(
      (answer) => current && setClosed(!answer.open),
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
      },
    );
    return () => {
      current = false;
    };
  }, []);
  return closed;
}

function SignUpForm({ onSent }: { onSent: () => void }) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const password = useNewPassword();
  const signUp = useAction(async () => {
    const body = { name, email, password: password.value };
    await request(created, "/api/auth/sign-up/email", { method: "POST", body, envelope: false });
    onSent();
  }, password.clearIfRefused);
  const submit = () => {
    if (password.check()) void signUp.run();
  };
  return (
    <>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-5"
      >
        <TextField
          label={t({ id: "auth.sign_up.name", message: "Name" })}
          name="name"
          testId="sign-up-name"
          autoComplete="name"
          isRequired
          value={name}
          onChange={setName}
        />
        <TextField
          label={t({ id: "auth.sign_in.email", message: "Email" })}
          name="email"
          testId="sign-up-email"
          type="email"
          autoComplete="email"
          isRequired
          value={email}
          onChange={setEmail}
        />
        <NewPasswordField
          label={t({ id: "auth.sign_in.password", message: "Password" })}
          testId="sign-up-password"
          {...password.props}
        />
        <SubmitButton testId="sign-up-submit" pending={signUp.pending} online={signUp.online}>
          <Trans id="auth.sign_up.submit">Create account</Trans>
        </SubmitButton>
      </Form>
      {signUp.failure ? (
        <ErrorPanel
          focusOnMount
          error={signUp.failure}
          onRetry={submit}
          {...authCopy("sign-up", signUp.failure)}
        />
      ) : null}
    </>
  );
}

/** A-02 sign up (`/sign-up`): the answer is alike for every address, so it never says whether one exists. */
export function SignUpPage() {
  const closed = useInvitationOnly();
  const [sent, setSent] = useState(false);
  return (
    <AuthFrame
      title={<Trans id="auth.sign_up.title">Create your account</Trans>}
      step={sent ? "sent" : "form"}
    >
      {sent ? (
        <>
          <p role="status" data-testid="sign-up-sent">
            <Trans id="auth.sign_up.sent">
              Check your email. If this address can sign up, we sent a link to confirm it.
            </Trans>
          </p>
          <Link to="/sign-in" className="text-link underline">
            <Trans id="system.sign_in.title">Sign in</Trans>
          </Link>
        </>
      ) : (
        <>
          {closed ? (
            <Banner tone="info" announce={false}>
              <Trans id="auth.sign_up.closed">
                This installation is invitation-only. If you were invited, use the address the invitation was
                sent to.
              </Trans>
            </Banner>
          ) : null}
          <SignUpForm onSent={() => setSent(true)} />
        </>
      )}
    </AuthFrame>
  );
}
