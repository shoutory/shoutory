import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Link } from "react-router";
import { z } from "zod";
import { request } from "../http/client";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { authCopy } from "./auth-copy";
import { AuthFrame, SubmitButton, useAction } from "./auth-frame";

const sent = z.object({ status: z.boolean() });

export function ForgotPage() {
  const { t } = useLingui();
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const forgot = useAction(async () => {
    await request(sent, "/api/auth/request-password-reset", {
      method: "POST",
      body: { email },
      envelope: false,
    });
    setDone(true);
  });
  const title = <Trans id="auth.forgot.title">Reset your password</Trans>;
  if (done) {
    return (
      <AuthFrame title={title} step="done">
        <p role="status">
          <Trans id="auth.forgot.sent">If an address matches, we sent a link to reset the password.</Trans>
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
          void forgot.run();
        }}
        className="flex flex-col gap-5"
      >
        <TextField
          label={t({ id: "auth.sign_in.email", message: "Email" })}
          name="email"
          type="email"
          autoComplete="email"
          isRequired
          value={email}
          onChange={setEmail}
        />
        <SubmitButton pending={forgot.pending} online={forgot.online}>
          <Trans id="auth.forgot.submit">Send the link</Trans>
        </SubmitButton>
      </Form>
      {forgot.failure ? (
        <ErrorPanel focusOnMount error={forgot.failure} {...authCopy("link", forgot.failure)} />
      ) : null}
    </AuthFrame>
  );
}
