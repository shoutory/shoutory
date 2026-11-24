import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Form } from "react-aria-components";
import { z } from "zod";
import { authCopy } from "../auth/auth-copy";
import { SubmitButton, useAction } from "../auth/auth-frame";
import { NewPasswordField, useNewPassword } from "../auth/new-password";
import { useStepUp } from "../auth/step-up";
import { type ApiError, request } from "../http/client";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { StepHeading } from "./recovery-codes";

const changed = z.object({ user: z.object({ email: z.string() }) });

function FailedChange({ error }: { error: ApiError }) {
  if (error.details?.reason === "password_breached") {
    return (
      <ErrorPanel
        focusOnMount
        error={error}
        what={<Trans id="account.security.breached.what">That password appeared in a data breach</Trans>}
        meaning={
          <Trans id="account.security.breached.meaning">Choose a password you have not used before.</Trans>
        }
      />
    );
  }
  const screen = error.details?.reason === "current_password_wrong" ? "step-up" : "reset";
  return <ErrorPanel focusOnMount error={error} {...authCopy(screen, error)} />;
}

export function ChangePassword({ onChanged }: { onChanged: () => void }) {
  const { t } = useLingui();
  const stepUp = useStepUp();
  const [current, setCurrent] = useState("");
  const next = useNewPassword();
  const [done, setDone] = useState(false);
  const change = useAction(
    async () => {
      const body = { currentPassword: current, newPassword: next.value };
      await stepUp(() =>
        request(changed, "/api/auth/change-password", { method: "POST", body, envelope: false }),
      );
      setCurrent("");
      next.clear();
      setDone(true);
      onChanged();
    },
    (error) => {
      if (error.code === "validation_failed") {
        setCurrent("");
        next.clear();
      }
    },
  );
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        setDone(false);
        if (next.check()) void change.run();
      }}
      className="flex flex-col gap-5"
    >
      <StepHeading focus={false}>
        <Trans id="account.security.password">Password</Trans>
      </StepHeading>
      <TextField
        label={t({ id: "account.security.current_password", message: "Current password" })}
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        isRequired
        value={current}
        onChange={setCurrent}
      />
      <NewPasswordField
        label={t({ id: "account.security.new_password", message: "New password" })}
        name="newPassword"
        {...next.props}
      />
      <SubmitButton pending={change.pending} online={change.online}>
        <Trans id="account.security.change">Change password</Trans>
      </SubmitButton>
      <p role="status">
        {done ? (
          <Trans id="account.security.changed">
            Your password was changed. Other devices were signed out. This device stays signed in.
          </Trans>
        ) : null}
      </p>
      {change.failure ? <FailedChange error={change.failure} /> : null}
    </Form>
  );
}
