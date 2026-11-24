import { Trans } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { z } from "zod";
import { useLoad } from "../account/use-load";
import { useStepUp } from "../auth/step-up";
import { request } from "../http/client";
import { changeCopy, Listed, useChange } from "../settings/member-actions";
import { ErrorPanel } from "../ui/error-panel";
import { Switch } from "../ui/switch";

// A row is absent until an admin writes it, and absent means sign-up is off.
const settingsSchema = z.array(z.object({ key: z.string(), value: z.unknown() }));
const saved = z.object({ key: z.string(), value: z.boolean() });

function SignupSwitch({ initial }: { initial: boolean }) {
  const stepUp = useStepUp();
  const [on, setOn] = useState(initial);
  const wanted = useRef(initial);
  const change = useChange(async () => {
    // Read once: a replay after the password check sends the value that was chosen.
    const value = wanted.current;
    await stepUp(() =>
      request(saved, "/api/v1/admin/settings/signup_enabled", { method: "PUT", body: { value } }),
    );
    setOn(value);
  });
  return (
    <section className="flex max-w-prose flex-col gap-5">
      <p>
        {on ? (
          <Trans id="admin.signup.effect_on">Anyone can sign up for an account on this installation.</Trans>
        ) : (
          <Trans id="admin.signup.effect_off">Sign-up is off: only invited addresses can sign up.</Trans>
        )}
      </p>
      <Switch
        label={<Trans id="admin.signup.label">Allow anyone to sign up</Trans>}
        isSelected={on}
        busy={change.pending}
        busyText={<Trans id="admin.signup.saving">Saving…</Trans>}
        onChange={(next) => {
          wanted.current = next;
          void change.run();
        }}
      />
      <p className="text-text-muted">
        <Trans id="admin.signup.exceptions">
          The first sign-up on an empty instance is always open, and an invited address may still sign up
          while this is off.
        </Trans>
      </p>
      {change.failure ? (
        <ErrorPanel focusOnMount error={change.failure} {...changeCopy(change.failure)} />
      ) : null}
    </section>
  );
}

export function SignupSwitchPage() {
  const { state, reload } = useLoad(settingsSchema, "/api/v1/admin/settings");
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="admin.signup.title">Sign-up</Trans>
      </h1>
      <Listed state={state} reload={reload}>
        {(rows) => (
          <SignupSwitch initial={rows.find((row) => row.key === "signup_enabled")?.value === true} />
        )}
      </Listed>
    </>
  );
}
