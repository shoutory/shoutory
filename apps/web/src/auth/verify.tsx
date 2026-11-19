import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Link } from "react-router";
import { z } from "zod";
import { request } from "../http/client";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { authCopy } from "./auth-copy";
import { AuthFrame, BadLink, SubmitButton, useAction } from "./auth-frame";
import { useMailedToken } from "./link-token";

const verified = z.object({ verified: z.boolean() });
const sent = z.object({ status: z.boolean() });

// A dead link asks for the address and sends a new link; the answer is alike for every address.
function ResendForm() {
  const { t } = useLingui();
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const resend = useAction(async () => {
    await request(sent, "/api/auth/send-verification-email", {
      method: "POST",
      body: { email },
      envelope: false,
    });
    setDone(true);
  });
  if (done) {
    return (
      <p role="status">
        <Trans id="auth.verify.resent">If this address needs confirming, we sent a new link.</Trans>
      </p>
    );
  }
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void resend.run();
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
      <SubmitButton pending={resend.pending} online={resend.online}>
        <Trans id="auth.verify.resend">Send a new link</Trans>
      </SubmitButton>
      {resend.failure ? (
        <ErrorPanel focusOnMount error={resend.failure} {...authCopy("link", resend.failure)} />
      ) : null}
    </Form>
  );
}

/** The email-verify page (`/auth/verify#token`): it opens and changes nothing; the press confirms the address. */
export function VerifyPage() {
  const token = useMailedToken();
  const [done, setDone] = useState(false);
  const [dead, setDead] = useState(token === null);
  const confirm = useAction(
    async () => {
      await request(verified, "/api/auth/verify-email", { method: "POST", body: { token } });
      setDone(true);
    },
    (error) => error.code === "link_unusable" && setDead(true),
  );
  const title = <Trans id="auth.verify.title">Confirm your email</Trans>;
  if (dead) {
    return (
      <AuthFrame title={title} step="dead">
        <BadLink action={<ResendForm />} />
      </AuthFrame>
    );
  }
  if (done) {
    return (
      <AuthFrame title={title} step="done">
        <p role="status">
          <Trans id="auth.verify.done">Your email is confirmed.</Trans>
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
          void confirm.run();
        }}
      >
        <SubmitButton pending={confirm.pending} online={confirm.online}>
          <Trans id="auth.verify.submit">Confirm my email</Trans>
        </SubmitButton>
      </Form>
      {confirm.failure ? (
        <ErrorPanel focusOnMount error={confirm.failure} {...authCopy("link", confirm.failure)} />
      ) : null}
    </AuthFrame>
  );
}
