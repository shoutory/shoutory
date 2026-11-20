import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { Form } from "react-aria-components";
import { z } from "zod";
import { SubmitButton } from "../auth/auth-frame";
import { type ApiError, request } from "../http/client";
import type { Workspace } from "../shell/shell-data";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { ErrorPanel } from "../ui/error-panel";
import { Select } from "../ui/select";
import { TextField } from "../ui/text-field";
import { changeCopy, useChange } from "./member-actions";
import { assignableFor, ROLES, rankOf } from "./roles";

const MAX_EMAIL = 254;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const sent = z.object({ id: z.string(), email: z.string(), role_key: z.string() });

// How long an invitation lasts, in seconds: from one hour to 14 days, which the server accepts; 48 hours is its own.
const EXPIRIES = [
  { seconds: 3600, label: msg({ id: "invite.exp_1h", message: "1 hour" }) },
  { seconds: 86_400, label: msg({ id: "invite.exp_24h", message: "24 hours" }) },
  { seconds: 172_800, label: msg({ id: "invite.exp_48h", message: "48 hours" }) },
  { seconds: 604_800, label: msg({ id: "invite.exp_7d", message: "7 days" }) },
  { seconds: 1_209_600, label: msg({ id: "invite.exp_14d", message: "14 days" }) },
];
const DEFAULT_EXPIRY = "172800";

// A duplicate and the limit of 100 pending invitations have their own words; the rest are the generic ones.
function inviteCopy(error: ApiError) {
  if (error.details?.reason === "pending_duplicate")
    return {
      what: <Trans id="invite.duplicate.what">That person is already invited</Trans>,
      meaning: (
        <Trans id="invite.duplicate.meaning">
          An invitation to that address is still pending. Revoke it to send a new one. Nothing was changed.
        </Trans>
      ),
    };
  if (error.code === "limit_reached")
    return {
      what: <Trans id="invite.limit.what">We could not send the invitation</Trans>,
      meaning: (
        <Trans id="invite.limit.meaning">
          This workspace already has 100 pending invitations, the most it can hold. Revoke some first. Nothing
          was changed.
        </Trans>
      ),
    };
  return changeCopy(error);
}

function EmailField(props: { value: string; invalid: boolean; onChange: (value: string) => void }) {
  const { t } = useLingui();
  return (
    <TextField
      label={t({ id: "invite.email", message: "Email" })}
      name="email"
      testId="invite-email"
      type="email"
      maxLength={MAX_EMAIL}
      value={props.value}
      onChange={props.onChange}
      {...(props.invalid
        ? { errorMessage: t({ id: "invite.email_bad", message: "Enter a valid email address." }) }
        : {})}
    />
  );
}

function InviteForm({ workspace, onSent }: { workspace: Workspace; onSent: () => void }) {
  const { t, i18n } = useLingui();
  const form = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [expiry, setExpiry] = useState(DEFAULT_EXPIRY);
  const [invalid, setInvalid] = useState(false);
  const invite = useChange(async () => {
    const body = { email: email.trim(), role_key: role, expires_in: Number(expiry) };
    await request(sent, `/api/v1/workspaces/${workspace.id}/invitations`, { method: "POST", body });
    onSent();
  });
  const roles = assignableFor(rankOf(workspace.role)).map((value) => ({
    value,
    label: i18n._(ROLES[value]),
  }));
  const expiries = EXPIRIES.map((option) => ({ value: String(option.seconds), label: i18n._(option.label) }));
  return (
    <Form
      ref={form}
      validationBehavior="aria"
      onSubmit={(event) => {
        event.preventDefault();
        const bad = !EMAIL.test(email.trim());
        setInvalid(bad);
        if (bad) form.current?.querySelector<HTMLInputElement>('input[name="email"]')?.focus();
        else void invite.run();
      }}
      className="flex flex-col gap-5"
    >
      <EmailField
        value={email}
        invalid={invalid}
        onChange={(value) => {
          setEmail(value);
          setInvalid(false);
        }}
      />
      <Select
        label={t({ id: "invite.role", message: "Role" })}
        testId="invite-role"
        value={role}
        onChange={setRole}
        options={roles}
      />
      <Select
        label={t({ id: "invite.expiry", message: "Expires after" })}
        value={expiry}
        onChange={setExpiry}
        options={expiries}
      />
      {invite.failure ? (
        <ErrorPanel focusOnMount error={invite.failure} {...inviteCopy(invite.failure)} />
      ) : null}
      <SubmitButton testId="invite-submit" pending={invite.pending} online={invite.online}>
        <Trans id="invite.send">Send invitation</Trans>
      </SubmitButton>
    </Form>
  );
}

/** The Invite button and its dialog; the dialog closes only after the server's answer, then the list is read again. */
export function InviteButton({ workspace, onSent }: { workspace: Workspace; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)} data-testid="invite-open">
        <Trans id="invite.open">Invite</Trans>
      </Button>
      <Dialog title={<Trans id="invite.title">Invite someone</Trans>} isOpen={open} onOpenChange={setOpen}>
        <InviteForm
          workspace={workspace}
          onSent={() => {
            setOpen(false);
            onSent();
          }}
        />
      </Dialog>
    </>
  );
}
