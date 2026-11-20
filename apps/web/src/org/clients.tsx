import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { Link, useNavigate, useParams, useRevalidator } from "react-router";
import { z } from "zod";
import { readZone } from "../account/prefs";
import { authCopy } from "../auth/auth-copy";
import { SubmitButton, useAction } from "../auth/auth-frame";
import { type ApiError, request } from "../http/client";
import { NotFoundPage } from "../pages/system-pages";
import { ROLES } from "../settings/roles";
import { type Organization, useShellData, type Workspace } from "../shell/shell-data";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DirText } from "../ui/dir-text";
import { EmptyState } from "../ui/empty-state";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { ZonePicker } from "../zones/zone-picker";

// The server's limit for a workspace name.
const MAX_NAME = 128;
const created = z.object({ id: z.string() });

// The organization holds 100 clients at most: that refusal has its own words, the rest are the generic ones.
function clientCopy(error: ApiError) {
  if (error.code !== "limit_reached") return authCopy("link", error);
  return {
    what: <Trans id="org.clients.limit.what">We could not add the client</Trans>,
    meaning: (
      <Trans id="org.clients.limit.meaning">
        This organization already has 100 clients, the most it can hold. Nothing was changed.
      </Trans>
    ),
  };
}

function AddClient({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const form = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [zone, setZone] = useState(readZone);
  const [invalid, setInvalid] = useState(false);
  const add = useAction(
    async () => {
      const body = { organization_id: orgId, name: name.trim(), default_tz: zone };
      await request(created, "/api/v1/workspaces", { method: "POST", body });
      // The lists now hold the client; the dialog closes only after the answer.
      await revalidator.revalidate();
      onDone();
    },
    (error) => {
      if (error.state === "session_expired")
        void navigate(`/sign-in?return-to=${encodeURIComponent(`/o/${orgId}/clients`)}`);
    },
  );
  return (
    <Form
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        const empty = name.trim() === "";
        setInvalid(empty);
        if (empty) form.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
        else void add.run();
      }}
      className="flex flex-col gap-5"
    >
      <TextField
        label={t({ id: "org.clients.name", message: "Name of the client" })}
        name="name"
        testId="clients-name"
        maxLength={MAX_NAME}
        value={name}
        onChange={(value) => {
          setName(value);
          setInvalid(false);
        }}
        {...(invalid
          ? { errorMessage: t({ id: "onboarding.name_required", message: "Enter a name." }) }
          : {})}
      />
      <ZonePicker
        label={t({ id: "account.profile.zone", message: "Time zone" })}
        value={zone}
        onChange={setZone}
      />
      <SubmitButton testId="clients-create" pending={add.pending} online={add.online}>
        <Trans id="onboarding.create">Create</Trans>
      </SubmitButton>
      {add.failure ? <ErrorPanel focusOnMount error={add.failure} {...clientCopy(add.failure)} /> : null}
    </Form>
  );
}

function ClientRow({ client }: { client: Workspace }) {
  const { i18n } = useLingui();
  const role = ROLES[client.role as keyof typeof ROLES];
  return (
    <tr>
      <td className="py-2 pe-5 wrap-anywhere">
        <Link to={`/w/${client.id}`} className="text-link underline">
          <DirText>{client.name}</DirText>
        </Link>
      </td>
      <td className="py-2 pe-5">
        <DirText dir="ltr">{client.slug}</DirText>
      </td>
      <td className="py-2 pe-5">{i18n._(role ?? ROLES.member)}</td>
      <td className="py-2">
        <Link to={`/w/${client.id}/settings/general`} className="text-link underline">
          <Trans id="org.clients.settings">Settings</Trans>
          <span className="sr-only">
            {" "}
            <DirText>{client.name}</DirText>
          </span>
        </Link>
      </td>
    </tr>
  );
}

function ClientTable({ clients }: { clients: Workspace[] }) {
  const { t } = useLingui();
  return (
    <div className="overflow-x-auto">
      <table aria-label={t({ id: "org.clients.title", message: "Clients" })} className="w-full text-start">
        <thead>
          <tr>
            <th className="pe-5 text-start">
              <Trans id="org.clients.col_name">Name</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="org.clients.col_slug">Address name</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="org.clients.col_role">Your role</Trans>
            </th>
            <th className="sr-only">
              <Trans id="org.clients.col_action">Action</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => (
            <ClientRow key={client.id} client={client} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Clients({ org, clients }: { org: Organization; clients: Workspace[] }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const canAdd = org.org_role === "owner" || org.org_role === "admin";
  const empty = clients.length === 0;
  const show = () => setOpen(true);
  const why = t({ id: "org.clients.no_add", message: "Only organization admins can add clients." });
  const addFirst = t({ id: "org.clients.add_first", message: "Add your first client" });
  // A client was added: the dialog is gone, so focus goes to the heading and the status line says what happened.
  useEffect(() => {
    if (added > 0) heading.current?.focus();
  }, [added]);
  return (
    <>
      <h1 ref={heading} tabIndex={-1} className="font-heading text-2xl outline-none">
        <Trans id="org.clients.title">Clients</Trans>
      </h1>
      <p role="status">{added > 0 ? <Trans id="org.clients.added">Client added.</Trans> : null}</p>
      {empty && canAdd ? null : (
        <div className="flex flex-col items-start gap-2">
          <Button
            data-testid="clients-add"
            aria-disabled={!canAdd}
            onPress={show}
            {...(canAdd ? {} : { reason: why })}
          >
            <Trans id="org.clients.add">Add client</Trans>
          </Button>
        </div>
      )}
      {empty ? (
        <EmptyState
          kind="first-use"
          title={<Trans id="org.clients.empty_title">No clients yet</Trans>}
          {...(canAdd ? { action: { label: addFirst, onPress: show } } : {})}
        >
          <Trans id="org.clients.empty_body">
            A client is a workspace with its own channels, calendar and approvals.
          </Trans>
        </EmptyState>
      ) : (
        <ClientTable clients={clients} />
      )}
      <Dialog title={<Trans id="org.clients.add">Add client</Trans>} isOpen={open} onOpenChange={setOpen}>
        <AddClient
          orgId={org.id}
          onDone={() => {
            setOpen(false);
            setAdded((now) => now + 1);
          }}
        />
      </Dialog>
    </>
  );
}

/** O-02 (`/o/:org/clients`): the organization's clients, and the dialog that adds one. A personal organization has none. */
export function ClientsPage() {
  const { org: id } = useParams();
  const data = useShellData();
  if ("error" in data)
    return (
      <h1 className="font-heading text-2xl">
        <Trans id="org.clients.title">Clients</Trans>
      </h1>
    );
  const org = data.organizations.find((candidate) => candidate.id === id);
  if (!org || org.type === "personal") return <NotFoundPage />;
  return (
    <Clients org={org} clients={data.workspaces.filter((client) => client.organization_id === org.id)} />
  );
}
