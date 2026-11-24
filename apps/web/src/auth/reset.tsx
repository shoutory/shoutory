import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Link } from "react-router";
import { z } from "zod";
import { request } from "../http/client";
import { ErrorPanel } from "../ui/error-panel";
import { authCopy } from "./auth-copy";
import { AuthFrame, BadLink, SubmitButton, useAction } from "./auth-frame";
import { useMailedToken } from "./link-token";
import { NewPasswordField, useNewPassword } from "./new-password";

const changed = z.object({ status: z.boolean() });
const NEW_LINK = (
  <Link to="/forgot" className="text-link underline">
    <Trans id="auth.reset.new_link">Send a new link</Trans>
  </Link>
);

export function ResetPage() {
  const { t } = useLingui();
  const token = useMailedToken();
  const password = useNewPassword();
  const [done, setDone] = useState(false);
  const [dead, setDead] = useState(token === null);
  const reset = useAction(
    async () => {
      const body = { token, newPassword: password.value };
      await request(changed, "/api/auth/reset-password", { method: "POST", body, envelope: false });
      setDone(true);
    },
    (error) => {
      password.clearIfRefused(error);
      if (error.code === "link_unusable") {
        password.clear();
        setDead(true);
      }
    },
  );
  const title = <Trans id="auth.reset.title">Choose a new password</Trans>;
  if (dead) {
    return (
      <AuthFrame title={title} step="dead">
        <BadLink action={NEW_LINK} />
      </AuthFrame>
    );
  }
  if (done) {
    return (
      <AuthFrame title={title} step="done">
        <p role="status">
          <Trans id="auth.reset.done">Your password was changed. Other devices were signed out.</Trans>
        </p>
        <Link to="/sign-in" className="text-link underline">
          <Trans id="system.sign_in.title">Sign in</Trans>
        </Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={title}>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          if (password.check()) void reset.run();
        }}
        className="flex flex-col gap-5"
      >
        <NewPasswordField
          label={t({ id: "auth.reset.password", message: "New password" })}
          {...password.props}
        />
        <SubmitButton pending={reset.pending} online={reset.online}>
          <Trans id="auth.reset.submit">Set new password</Trans>
        </SubmitButton>
      </Form>
      {reset.failure ? (
        <ErrorPanel focusOnMount error={reset.failure} {...authCopy("reset", reset.failure)} />
      ) : null}
    </AuthFrame>
  );
}
