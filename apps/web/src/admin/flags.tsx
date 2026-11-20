import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { z } from "zod";
import { useLoad } from "../account/use-load";
import { useStepUp } from "../auth/step-up";
import { request } from "../http/client";
import { changeCopy, Listed, useChange } from "../settings/member-actions";
import { DirText } from "../ui/dir-text";
import { ErrorPanel } from "../ui/error-panel";
import { Select } from "../ui/select";

const flagsSchema = z.array(
  z.object({
    key: z.string(),
    description: z.string(),
    owner: z.string(),
    remove_by: z.string(),
    default_on: z.boolean(),
    instance_override: z.boolean().nullable(),
    effective: z.boolean(),
  }),
);
type Flag = z.infer<typeof flagsSchema>[number];
const overridden = z.object({ key: z.string(), on: z.boolean().nullable() });

// The three states of an instance override, and the value each sends: on, off, or cleared back to the default.
const BODY = { on: true, off: false, default: null } as const;
type Choice = keyof typeof BODY;
const choiceOf = (flag: Flag): Choice =>
  flag.instance_override === null ? "default" : flag.instance_override ? "on" : "off";

// The override of one flag: choosing runs a sensitive write (a refused password check asks once and runs again, a
// cancelled one changes nothing). A flag past its removal date is refused by the server, so its list is unavailable
// and sends nothing.
function OverrideCell({ flag, expired, refresh }: { flag: Flag; expired: boolean; refresh: () => void }) {
  const { t } = useLingui();
  const stepUp = useStepUp();
  const chosen = useRef<Choice>(choiceOf(flag));
  const change = useChange(async () => {
    const on = BODY[chosen.current];
    const path = `/api/v1/admin/flags/${flag.key}/override`;
    await stepUp(() => request(overridden, path, { method: "PUT", body: { on } }));
    refresh();
  });
  const { key } = flag;
  const label = t({ id: "admin.flags.override_of", message: `Override of ${key}` });
  const gone = t({ id: "admin.flags.gone", message: "Past its removal date; it cannot be changed." });
  const saving = t({ id: "admin.flags.saving", message: "Saving the override…" });
  const reason = expired ? gone : saving;
  const byDefault = flag.default_on
    ? t({ id: "admin.flags.default_on", message: "Default (on)" })
    : t({ id: "admin.flags.default_off", message: "Default (off)" });
  const options = [
    { value: "on", label: t({ id: "admin.flags.on", message: "On" }) },
    { value: "off", label: t({ id: "admin.flags.off", message: "Off" }) },
    { value: "default", label: byDefault },
  ];
  return (
    <>
      <Select
        hideLabel
        testId={`override-${key}`}
        label={label}
        value={choiceOf(flag)}
        options={options}
        unavailable={expired || change.pending}
        reason={reason}
        onChange={(next) => {
          chosen.current = next as Choice;
          void change.run();
        }}
      />
      {change.failure ? (
        <ErrorPanel focusOnMount error={change.failure} {...changeCopy(change.failure)} />
      ) : null}
    </>
  );
}

function FlagRow({ flag, today, refresh }: { flag: Flag; today: string; refresh: () => void }) {
  // The removal date is a UTC calendar date: a flag is expired from the day after it.
  const expired = flag.remove_by < today;
  return (
    <tr
      data-testid={`flag-${flag.key}`}
      data-state={flag.effective ? "on" : "off"}
      {...(expired ? { "data-expired": "true" } : {})}
      className={expired ? "bg-attention-bg" : undefined}
    >
      <td className="py-2 pe-5 wrap-anywhere">
        <DirText dir="ltr">{flag.key}</DirText>
        <p className="text-sm text-text-muted">{flag.description}</p>
      </td>
      <td className="py-2 pe-5" data-testid="flag-owner">
        <DirText dir="ltr">{flag.owner}</DirText>
      </td>
      <td className="py-2 pe-5" data-testid="flag-remove-by">
        <DirText dir="ltr">{flag.remove_by}</DirText> (UTC)
        {expired ? (
          <>
            {" "}
            <strong data-testid="flag-expired">
              <Trans id="admin.flags.expired">Expired</Trans>
            </strong>
          </>
        ) : null}
      </td>
      <td className="py-2 pe-5">
        {flag.effective ? <Trans id="admin.flags.on">On</Trans> : <Trans id="admin.flags.off">Off</Trans>}
      </td>
      <td className="py-2">
        <OverrideCell flag={flag} expired={expired} refresh={refresh} />
      </td>
    </tr>
  );
}

function FlagTable({ flags, refresh }: { flags: Flag[]; refresh: () => void }) {
  const { t } = useLingui();
  // The clock is read once when the table appears.
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  return (
    // The scrolling wrapper is a named region that takes focus, so a keyboard can scroll a table wider than the screen
    // (a scrollable region needs a tab stop, which both rules below would refuse on a non-interactive element).
    // biome-ignore lint/a11y/useSemanticElements: a region with a tab stop, not a section the rule expects
    <div
      role="region"
      aria-label={t({ id: "admin.flags.title", message: "Feature flags" })}
      className="overflow-x-auto"
      data-testid="flags-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard
      tabIndex={0}
    >
      <table
        aria-label={t({ id: "admin.flags.title", message: "Feature flags" })}
        className="w-full text-start"
      >
        <thead>
          <tr>
            <th className="pe-5 text-start">
              <Trans id="admin.flags.col_flag">Flag</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="admin.flags.col_owner">Owner</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="admin.flags.col_remove_by">Removal date</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="admin.flags.col_state">State</Trans>
            </th>
            <th className="text-start">
              <Trans id="admin.flags.col_override">Override</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {flags.map((flag) => (
            <FlagRow key={flag.key} flag={flag} today={today} refresh={refresh} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Z-03: every feature flag with its owner, removal date and state, and the instance override of each. */
export function FlagsPage() {
  const { state, reload, refresh } = useLoad(flagsSchema, "/api/v1/admin/flags");
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="admin.flags.title">Feature flags</Trans>
      </h1>
      <Listed state={state} reload={reload}>
        {(flags) => <FlagTable flags={flags} refresh={refresh} />}
      </Listed>
    </>
  );
}
