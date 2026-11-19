import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { z } from "zod";
import { authCopy } from "../auth/auth-copy";
import { useAction } from "../auth/auth-frame";
import { request } from "../http/client";
import { Button } from "../ui/button";
import { DirText } from "../ui/dir-text";
import { ErrorPanel } from "../ui/error-panel";
import { LocalizedDateTime } from "../ui/localized";
import { StepHeading } from "./recovery-codes";
import { useLoad } from "./use-load";

const devices = z.array(
  z.object({
    id: z.string(),
    createdAt: z.string(),
    userAgent: z.string().nullable(),
    current: z.boolean(),
  }),
);
type Device = z.infer<typeof devices>[number];
const revoked = z.object({ revoked: z.boolean() });
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function EndSession({ id, onEnded }: { id: string; onEnded: () => void }) {
  const end = useAction(async () => {
    await request(revoked, "/api/auth/sessions/revoke", { method: "POST", body: { id } });
    onEnded();
  });
  return (
    <>
      <Button onPress={() => void end.run()} busy={end.pending} aria-disabled={end.pending || !end.online}>
        <Trans id="account.security.end_session">End session</Trans>
      </Button>
      {end.failure ? (
        <ErrorPanel focusOnMount error={end.failure} {...authCopy("link", end.failure)} />
      ) : null}
    </>
  );
}

function DeviceRow({ device, onEnded }: { device: Device; onEnded: () => void }) {
  return (
    <tr>
      <td className="py-2 pe-5 wrap-anywhere">
        {device.current ? (
          <strong>
            <Trans id="account.security.this_device">This device</Trans>
          </strong>
        ) : null}{" "}
        {device.userAgent ? (
          <DirText dir="ltr">{device.userAgent}</DirText>
        ) : (
          <Trans id="account.security.unknown_device">Unknown device</Trans>
        )}
      </td>
      <td className="py-2 pe-5">
        <LocalizedDateTime value={new Date(device.createdAt)} timeZone={zone} />
      </td>
      <td className="py-2">{device.current ? null : <EndSession id={device.id} onEnded={onEnded} />}</td>
    </tr>
  );
}

/** The devices signed in as this person, newest first (at most 100), with a button to end each but this one. */
export function Sessions() {
  const { t } = useLingui();
  const { state, replace, reload } = useLoad(devices, "/api/auth/sessions");
  // A removed row or a cleared list takes focus to the heading, so the change is announced and focus is not lost.
  const [moved, setMoved] = useState(0);
  const show = (next: Device[]) => {
    replace(next);
    setMoved((now) => now + 1);
  };
  const others = useAction(async () => {
    await request(revoked, "/api/auth/sessions/revoke-others", { method: "POST", body: {} });
    if (state.status === "done") show(state.data.filter((device) => device.current));
  });
  return (
    <section className="flex flex-col gap-3">
      <StepHeading focus={moved > 0} refocus={moved}>
        <Trans id="account.security.devices">Signed-in devices</Trans>
      </StepHeading>
      {state.status === "loading" ? (
        <p role="status">
          <Trans id="system.loading">Loading</Trans>
        </p>
      ) : null}
      {state.status === "failed" ? (
        <ErrorPanel focusOnMount error={state.error} onRetry={reload} {...authCopy("link", state.error)} />
      ) : null}
      {state.status === "done" ? (
        <>
          <div className="overflow-x-auto">
            <table
              aria-label={t({ id: "account.security.devices", message: "Signed-in devices" })}
              className="w-full text-start"
            >
              <thead>
                <tr>
                  <th className="pe-5 text-start">
                    <Trans id="account.security.device">Device</Trans>
                  </th>
                  <th className="pe-5 text-start">
                    <Trans id="account.security.signed_in">Signed in</Trans>
                  </th>
                  <th className="sr-only">
                    <Trans id="account.security.action">Action</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.data.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    onEnded={() => show(state.data.filter((other) => other.id !== device.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {state.data.some((device) => !device.current) ? (
            <div>
              <Button onPress={() => void others.run()} busy={others.pending} aria-disabled={others.pending}>
                <Trans id="account.security.end_others">Sign out other devices</Trans>
              </Button>
            </div>
          ) : null}
          {others.failure ? (
            <ErrorPanel focusOnMount error={others.failure} {...authCopy("link", others.failure)} />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
