import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { Link } from "react-router";
import { z } from "zod";
import { authCopy } from "../auth/auth-copy";
import { SubmitButton, useAction } from "../auth/auth-frame";
import { useStepUp } from "../auth/step-up";
import { request } from "../http/client";
import { formatNumber, type Locale } from "../i18n/i18n";
import { Banner } from "../ui/banner";
import { Button } from "../ui/button";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { useDigits } from "./prefs";
import { CodesStep, StepHeading } from "./recovery-codes";
import { useLoad } from "./use-load";

// When it is on, the count is a number; a status that says on with no count is not an answer of ours.
const state = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true), recovery_codes_left: z.number() }),
  z.object({ enabled: z.literal(false), recovery_codes_left: z.null() }),
]);
const generated = z.object({ backupCodes: z.array(z.string()) });

// The password goes with the request for new codes and is emptied after it; a stale identity check is asked for by X-04.
function NewCodesForm({ onCodes }: { onCodes: (codes: string[]) => void }) {
  const { t } = useLingui();
  const stepUp = useStepUp();
  const [password, setPassword] = useState("");
  // The form appears on a press of "New recovery codes": the password field takes focus.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => form.current?.querySelector("input")?.focus(), []);
  const generate = useAction(
    async () => {
      const body = { password };
      const answer = await stepUp(() =>
        request(generated, "/api/auth/two-factor/generate-backup-codes", {
          method: "POST",
          body,
          envelope: false,
        }),
      );
      setPassword("");
      onCodes(answer.backupCodes);
    },
    (error) => error.code === "validation_failed" && setPassword(""),
  );
  return (
    <Form
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        void generate.run();
      }}
      className="flex flex-col gap-5"
    >
      <TextField
        label={t({ id: "auth.sign_in.password", message: "Password" })}
        name="password"
        testId="codes-password"
        type="password"
        autoComplete="current-password"
        isRequired
        value={password}
        onChange={setPassword}
      />
      <SubmitButton testId="codes-generate" pending={generate.pending} online={generate.online}>
        <Trans id="account.security.generate">Generate codes</Trans>
      </SubmitButton>
      {generate.failure ? (
        <ErrorPanel focusOnMount error={generate.failure} {...authCopy("step-up", generate.failure)} />
      ) : null}
    </Form>
  );
}

function CodesLeft({ remaining }: { remaining: number }) {
  const { i18n } = useLingui();
  const count = formatNumber(remaining, { locale: i18n.locale as Locale, digits: useDigits() });
  if (remaining === 0) {
    return (
      <Banner tone="attention">
        <Trans id="account.security.codes_none">
          You have no recovery codes left. Make new ones so you can still sign in if you lose your
          authenticator app.
        </Trans>
      </Banner>
    );
  }
  return (
    <p>
      <Trans id="account.security.codes_left">Recovery codes remaining: {count}</Trans>
    </p>
  );
}

/** Whether two-step verification is on: off offers the setup, on shows the recovery codes left and new ones. */
export function TwoFactorBlock() {
  const { state: loaded, reload } = useLoad(state, "/api/auth/two-factor/status");
  const [asking, setAsking] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  if (codes) {
    return (
      <CodesStep
        codes={codes}
        onSaved={() => {
          setCodes(null);
          setSaved(true);
          reload();
        }}
      />
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <StepHeading focus={saved}>
        <Trans id="account.security.two_factor">Two-step verification</Trans>
      </StepHeading>
      {loaded.status === "loading" ? (
        // The room of the settled block (the status, the codes left and the button), so the devices below stay put.
        <p role="status" className="min-h-28">
          <Trans id="system.loading">Loading</Trans>
        </p>
      ) : null}
      {loaded.status === "failed" ? (
        <ErrorPanel focusOnMount error={loaded.error} onRetry={reload} {...authCopy("link", loaded.error)} />
      ) : null}
      {loaded.status === "done" && !loaded.data.enabled ? (
        <>
          <p>
            <Trans id="account.security.off">Two-step verification is off.</Trans>
          </p>
          <Link to="/account/security/two-factor" className="text-link underline">
            <Trans id="account.security.set_up">Set up</Trans>
          </Link>
        </>
      ) : null}
      {loaded.status === "done" && loaded.data.enabled ? (
        <>
          <p>
            <Trans id="account.security.on">Two-step verification is on.</Trans>
          </p>
          <CodesLeft remaining={loaded.data.recovery_codes_left} />
          {asking ? (
            <NewCodesForm
              onCodes={(next) => {
                setAsking(false);
                setCodes(next);
              }}
            />
          ) : (
            <div>
              <Button onPress={() => setAsking(true)} data-testid="codes-new">
                <Trans id="account.security.new_codes">New recovery codes</Trans>
              </Button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
