import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { z } from "zod";
import { readZone } from "../account/prefs";
import { useLoad } from "../account/use-load";
import { ApiError, request } from "../http/client";
import type { Workspace } from "../shell/shell-data";
import { Button } from "../ui/button";
import { DirText } from "../ui/dir-text";
import { EmptyState } from "../ui/empty-state";
import { LocalizedDateTime } from "../ui/localized";
import { InviteButton } from "./invite";
import { ConfirmChange, Listed, useHeadingFocus } from "./member-actions";
import { ROLES } from "./roles";

const invitationsSchema = z.array(
  z.object({
    id: z.string(),
    email: z.string(),
    role_key: z.string(),
    expires_at: z.iso.datetime({ offset: true }),
  }),
);
type Invitation = z.infer<typeof invitationsSchema>[number];

const nothing = z.null();

function revokeCopy(error: ApiError) {
  if (error.details?.reason !== "already_ended") return undefined;
  return {
    what: <Trans id="invitations.ended.what">That invitation is no longer pending</Trans>,
    meaning: (
      <Trans id="invitations.ended.meaning">It was accepted or revoked already. Nothing was changed.</Trans>
    ),
  };
}

function InvitationRow({ invitation, onRevoke }: { invitation: Invitation; onRevoke: () => void }) {
  const { i18n } = useLingui();
  const at = new Date(invitation.expires_at);
  const role = ROLES[invitation.role_key as keyof typeof ROLES];
  return (
    <tr>
      <td className="py-2 pe-5 wrap-anywhere">
        <DirText dir="ltr">{invitation.email}</DirText>
      </td>
      <td className="py-2 pe-5">{i18n._(role ?? ROLES.member)}</td>
      <td className="py-2 pe-5">
        {at.getTime() < Date.now() ? (
          <Trans id="invitations.expired">Expired</Trans>
        ) : (
          <LocalizedDateTime value={at} timeZone={readZone()} />
        )}
      </td>
      <td className="py-2">
        <Button onPress={onRevoke}>
          <Trans id="invitations.revoke">Revoke</Trans>
        </Button>
      </td>
    </tr>
  );
}

function InvitationTable({
  invitations,
  onRevoke,
}: {
  invitations: Invitation[];
  onRevoke: (invitation: Invitation) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="overflow-x-auto" data-testid="invitations-scroll">
      <table
        aria-label={t({ id: "invitations.title", message: "Pending invitations" })}
        className="w-full text-start"
      >
        <thead>
          <tr>
            <th className="pe-5 text-start">
              <Trans id="invitations.col_email">Email</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="members.col_role">Role</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="invitations.col_expires">Expires</Trans>
            </th>
            <th className="sr-only">
              <Trans id="members.col_actions">Actions</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              onRevoke={() => onRevoke(invitation)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Invitations({ workspace, stamp }: { workspace: Workspace; stamp: number }) {
  const { state, reload, refresh } = useLoad(
    invitationsSchema,
    `/api/v1/workspaces/${workspace.id}/invitations?limit=100`,
    stamp,
  );
  // Held here, not in a row, so reloading the list never closes the question.
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const heading = useHeadingFocus();
  const email = revoking?.email ?? "";
  const run = async () => {
    try {
      await request(nothing, `/api/v1/workspaces/${workspace.id}/invitations/${revoking?.id}`, {
        method: "DELETE",
      });
    } catch (error) {
      if (error instanceof ApiError && error.details?.reason === "already_ended") refresh();
      throw error;
    }
    refresh();
  };
  return (
    <section className="flex flex-col gap-3">
      <h2 ref={heading.ref} tabIndex={-1} className="font-heading text-xl outline-none">
        <Trans id="invitations.title">Pending invitations</Trans>
      </h2>
      <div>
        <InviteButton workspace={workspace} onSent={refresh} />
      </div>
      <Listed state={state} reload={reload}>
        {(invitations) =>
          invitations.length === 0 ? (
            <EmptyState
              kind="first-use"
              title={<Trans id="invitations.empty_title">No pending invitations</Trans>}
            >
              <Trans id="invitations.empty_body">
                Invite a person by email and they appear here until they join.
              </Trans>
            </EmptyState>
          ) : (
            <InvitationTable invitations={invitations} onRevoke={setRevoking} />
          )
        }
      </Listed>
      <ConfirmChange
        title={
          <Trans id="invitations.revoke_title">
            Revoke the invitation to <DirText dir="ltr">{email}</DirText>?
          </Trans>
        }
        label={<Trans id="invitations.revoke">Revoke</Trans>}
        isOpen={revoking !== null}
        onClose={() => setRevoking(null)}
        run={run}
        onDone={heading.move}
        copyFor={revokeCopy}
      >
        <Trans id="invitations.revoke_body">
          The link they were sent stops working. You can invite them again.
        </Trans>
      </ConfirmChange>
    </section>
  );
}
