import { Trans, useLingui } from "@lingui/react/macro";
import { ROLE_PERMISSIONS } from "@shoutory/core/authz";
import { useRef, useState } from "react";
import { useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import { z } from "zod";
import { useLoad } from "../account/use-load";
import { useStepUp } from "../auth/step-up";
import { type ApiError, request } from "../http/client";
import { NotFoundPage } from "../pages/system-pages";
import { SESSION_ROUTE_ID, type Session } from "../session/session";
import { useShellData, type Workspace } from "../shell/shell-data";
import { Button } from "../ui/button";
import { DirText } from "../ui/dir-text";
import { ErrorPanel } from "../ui/error-panel";
import { Select } from "../ui/select";
import { Invitations } from "./invitations";
import { ConfirmChange, changeCopy, Listed, useChange, useHeadingFocus } from "./member-actions";
import { ADMIN_RANK, assignableFor, ROLES, rankOf } from "./roles";

const membersSchema = z.array(
  z.object({ user_id: z.string(), name: z.string(), role: z.string(), status: z.string() }),
);
type Member = z.infer<typeof membersSchema>[number];

interface Actor {
  readonly workspace: Workspace;
  readonly rank: number;
  readonly me: string | undefined;
  readonly refresh: () => void;
  readonly refreshAll: () => void;
  readonly focusHeading: () => void;
}

const whenForbidden = (actor: Actor) => (error: ApiError) => {
  if (error.state === "forbidden") actor.refreshAll();
};

const changed = z.object({ user_id: z.string(), role: z.string() });

function RoleCell({ member, actor }: { member: Member; actor: Actor }) {
  const { t, i18n } = useLingui();
  const stepUp = useStepUp();
  const chosen = useRef(member.role);
  const change = useChange(async () => {
    // Read once, so a replay after the password check sends the role that was chosen.
    const role = chosen.current;
    const path = `/api/v1/workspaces/${actor.workspace.id}/members/${member.user_id}`;
    await stepUp(() => request(changed, path, { method: "PATCH", body: { role_key: role } }));
    actor.refresh();
  }, whenForbidden(actor));
  const { name } = member;
  const label = t({ id: "members.role_of", message: `Role of ${name}` });
  const saving = t({ id: "members.saving", message: "Saving the new role…" });
  const options = assignableFor(actor.rank).map((role) => ({
    value: role,
    label: i18n._(ROLES[role]),
  }));
  return (
    <>
      <Select
        hideLabel
        label={label}
        value={member.role}
        options={options}
        unavailable={change.pending}
        reason={saving}
        onChange={(role) => {
          chosen.current = role;
          void change.run();
        }}
      />
      {change.failure ? (
        <ErrorPanel focusOnMount error={change.failure} {...changeCopy(change.failure)} />
      ) : null}
    </>
  );
}

const nothing = z.null();

function RemoveCell({ member, actor }: { member: Member; actor: Actor }) {
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [declined, setDeclined] = useState<ApiError | null>(null);
  const { name } = member;
  const run = async () => {
    const path = `/api/v1/workspaces/${actor.workspace.id}/members/${member.user_id}`;
    await stepUp(() => request(nothing, path, { method: "DELETE" }));
    actor.refresh();
  };
  return (
    <>
      <Button
        data-testid="member-remove"
        onPress={() => {
          setDeclined(null);
          setOpen(true);
        }}
      >
        <Trans id="members.remove">Remove</Trans>
      </Button>
      {declined ? <ErrorPanel focusOnMount error={declined} {...changeCopy(declined)} /> : null}
      <ConfirmChange
        title={
          <Trans id="members.remove_title">
            Remove <DirText>{name}</DirText>?
          </Trans>
        }
        label={<Trans id="members.remove">Remove</Trans>}
        isOpen={open}
        onClose={() => setOpen(false)}
        run={run}
        onDone={actor.focusHeading}
        onFailure={whenForbidden(actor)}
        onDeclined={setDeclined}
      >
        <Trans id="members.remove_body">
          They lose access to this workspace now. You can invite them again.
        </Trans>
      </ConfirmChange>
    </>
  );
}

function LeaveWorkspace({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [open, setOpen] = useState(false);
  const { name } = workspace;
  const run = async () => {
    await request(nothing, `/api/v1/workspaces/${workspace.id}/members/me/leave`, { method: "POST" });
    await navigate("/");
    void revalidator.revalidate();
  };
  return (
    <>
      <Button onPress={() => setOpen(true)}>
        <Trans id="members.leave">Leave workspace</Trans>
      </Button>
      <ConfirmChange
        title={
          <Trans id="members.leave_title">
            Leave <DirText>{name}</DirText>?
          </Trans>
        }
        label={<Trans id="members.leave_confirm">Leave</Trans>}
        isOpen={open}
        onClose={() => setOpen(false)}
        run={run}
      >
        <Trans id="members.leave_body">
          You lose access to this workspace now. An owner or admin can invite you again.
        </Trans>
      </ConfirmChange>
    </>
  );
}

function MemberRow({ member, actor }: { member: Member; actor: Actor }) {
  const { i18n } = useLingui();
  const role = ROLES[member.role as keyof typeof ROLES];
  const self = member.user_id === actor.me;
  const below = !self && rankOf(member.role) < actor.rank && actor.rank >= ADMIN_RANK;
  return (
    <tr>
      <td className="py-2 pe-5 wrap-anywhere">
        <DirText>{member.name}</DirText>
        {self ? (
          <>
            {" "}
            <Trans id="members.you">(you)</Trans>
          </>
        ) : null}
      </td>
      <td className="py-2 pe-5">
        {below && member.status === "active" ? (
          <RoleCell member={member} actor={actor} />
        ) : (
          i18n._(role ?? ROLES.member)
        )}
        {member.role === "owner" ? (
          <p className="text-sm text-text-muted">
            <Trans id="members.one_owner">A workspace needs one Owner.</Trans>
          </p>
        ) : null}
      </td>
      <td className="py-2 pe-5">
        {member.status === "suspended" ? (
          <Trans id="members.status_suspended">Suspended</Trans>
        ) : (
          <Trans id="members.status_active">Active</Trans>
        )}
      </td>
      <td className="py-2">
        {below ? <RemoveCell member={member} actor={actor} /> : null}
        {self && member.role !== "owner" ? <LeaveWorkspace workspace={actor.workspace} /> : null}
      </td>
    </tr>
  );
}

function MemberTable({ members, actor }: { members: Member[]; actor: Actor }) {
  const { t } = useLingui();
  return (
    <div className="overflow-x-auto" data-testid="members-scroll">
      <table aria-label={t({ id: "members.title", message: "Members" })} className="w-full text-start">
        <thead>
          <tr>
            <th className="pe-5 text-start">
              <Trans id="members.col_name">Name</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="members.col_role">Role</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="members.col_status">Status</Trans>
            </th>
            <th className="sr-only">
              <Trans id="members.col_actions">Actions</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <MemberRow key={member.user_id} member={member} actor={actor} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ManageMembers({ workspace, focusHeading }: { workspace: Workspace; focusHeading: () => void }) {
  const session = useRouteLoaderData<Session>(SESSION_ROUTE_ID);
  // The largest page: the server's default of 20 would hide the rest.
  const { state, reload, refresh } = useLoad(
    membersSchema,
    `/api/v1/workspaces/${workspace.id}/members?limit=100`,
  );
  const [stamp, setStamp] = useState(0);
  const refreshAll = () => {
    refresh();
    setStamp((now) => now + 1);
  };
  const actor = {
    workspace,
    rank: rankOf(workspace.role),
    me: session?.user.id,
    refresh,
    refreshAll,
    focusHeading,
  };
  return (
    <>
      <p className="text-text-muted">
        <Trans id="members.org_admins">
          Organization owners and admins have access to every workspace without being listed here.
        </Trans>
      </p>
      <Listed state={state} reload={reload} reserve="min-h-56">
        {(members) => <MemberTable members={members} actor={actor} />}
      </Listed>
      <Invitations workspace={workspace} stamp={stamp} />
    </>
  );
}

function Members({ workspace }: { workspace: Workspace }) {
  const permissions: Readonly<Record<string, readonly string[] | undefined>> = ROLE_PERMISSIONS;
  const canManage = permissions[workspace.role]?.includes("settings.manage") ?? false;
  const heading = useHeadingFocus();
  return (
    <>
      <h1 ref={heading.ref} tabIndex={-1} className="font-heading text-2xl outline-none">
        <Trans id="members.title">Members</Trans>
      </h1>
      {canManage ? (
        <ManageMembers workspace={workspace} focusHeading={heading.move} />
      ) : (
        <>
          <p>
            <Trans id="members.need_admin">You need the admin role to see the members.</Trans>
          </p>
          <div>
            <LeaveWorkspace workspace={workspace} />
          </div>
        </>
      )}
    </>
  );
}

export function MembersPage() {
  const { ws } = useParams();
  const data = useShellData();
  if ("error" in data)
    return (
      <h1 className="font-heading text-2xl">
        <Trans id="members.title">Members</Trans>
      </h1>
    );
  const workspace = data.workspaces.find((candidate) => candidate.id === ws);
  const org = data.organizations.find((candidate) => candidate.id === workspace?.organization_id);
  if (!workspace || !org || org.type === "personal") return <NotFoundPage />;
  return <Members workspace={workspace} />;
}
