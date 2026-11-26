import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { Link, useNavigate, useParams, useRevalidator } from "react-router";
import { z } from "zod";
import { readZone } from "../account/prefs";
import { authCopy } from "../auth/auth-copy";
import { SubmitButton, useAction } from "../auth/auth-frame";
import { type ApiError, keyedPost } from "../http/client";
import { NotFoundPage } from "../pages/system-pages";
import { ArchiveControl } from "../settings/archive";
import { ROLES } from "../settings/roles";
import { WorkspaceAvatar } from "../settings/workspace-avatar";
import { ArchivedMark } from "../shell/choice-list";
import { type Organization, useShellData, type Workspace } from "../shell/shell-data";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DirText } from "../ui/dir-text";
import { EmptyState } from "../ui/empty-state";
import { ErrorPanel } from "../ui/error-panel";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { TextField } from "../ui/text-field";
import { ZonePicker } from "../zones/zone-picker";

const MAX_NAME = 128;
const created = z.object({ id: z.string() });

function clientCopy(error: ApiError) {
  if (error.state === "not_found")
    return {
      what: <Trans id="org.clients.template_gone.what">That template client is no longer available</Trans>,
      meaning: (
        <Trans id="org.clients.template_gone.meaning">
          Nothing was created. Choose another template or none.
        </Trans>
      ),
    };
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

function TemplateSelect({
  templates,
  value,
  onChange,
}: {
  templates: Workspace[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useLingui();
  if (templates.length === 0) return null;
  const none = { value: "", label: t({ id: "org.clients.no_template", message: "No template" }) };
  return (
    <div className="flex flex-col gap-2">
      <Select
        label={t({ id: "org.clients.template", message: "Copy settings from" })}
        testId="clients-template"
        value={value}
        onChange={onChange}
        options={[none, ...templates.map((client) => ({ value: client.id, label: client.name }))]}
      />
      <p className="text-sm text-text-muted">
        <Trans id="org.clients.template_hint">
          Copies the colour, the time zone and the late-publish window. Channels, posts and members are not
          copied.
        </Trans>
      </p>
    </div>
  );
}

// A template brings its own time zone, so the zone is asked for only without one.
const bodyOf = (orgId: string, name: string, zone: string, template: string) => ({
  organization_id: orgId,
  name: name.trim(),
  ...(template === "" ? { default_tz: zone } : { template_workspace_id: template }),
});

function NameField({
  value,
  invalid,
  onChange,
}: {
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  return (
    <TextField
      label={t({ id: "org.clients.name", message: "Name of the client" })}
      name="name"
      testId="clients-name"
      maxLength={MAX_NAME}
      value={value}
      onChange={onChange}
      {...(invalid ? { errorMessage: t({ id: "onboarding.name_required", message: "Enter a name." }) } : {})}
    />
  );
}

function AddClient({
  orgId,
  templates,
  onDone,
}: {
  orgId: string;
  templates: Workspace[];
  onDone: () => void;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const form = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [zone, setZone] = useState(readZone);
  const [template, setTemplate] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [post] = useState(keyedPost);
  const add = useAction(
    async () => {
      await post(created, "/api/v1/workspaces", bodyOf(orgId, name, zone, template));
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
      <NameField
        value={name}
        invalid={invalid}
        onChange={(value) => {
          setName(value);
          setInvalid(false);
        }}
      />
      <TemplateSelect templates={templates} value={template} onChange={setTemplate} />
      {template === "" ? (
        <ZonePicker
          label={t({ id: "account.profile.zone", message: "Time zone" })}
          value={zone}
          onChange={setZone}
        />
      ) : null}
      <SubmitButton testId="clients-create" pending={add.pending} online={add.online}>
        <Trans id="onboarding.create">Create</Trans>
      </SubmitButton>
      {add.failure ? <ErrorPanel focusOnMount error={add.failure} {...clientCopy(add.failure)} /> : null}
    </Form>
  );
}

// A link in a table cell is not exempt from the target size rule: 24 px each way, 44 px on a touch screen.
const ROW_LINK = "inline-flex min-h-6 min-w-6 pointer-coarse:min-h-11 items-center text-link underline";

function ClientRow({ client }: { client: Workspace }) {
  const { i18n } = useLingui();
  const role = ROLES[client.role as keyof typeof ROLES];
  return (
    <tr data-archived={client.archived_at ? "true" : undefined}>
      <td className="py-2 pe-5 wrap-anywhere">
        <span className="flex items-center gap-3">
          <WorkspaceAvatar workspace={client} />
          <Link to={`/w/${client.id}`} className={ROW_LINK}>
            <DirText>{client.name}</DirText>
          </Link>
          <ArchivedMark choice={client} />
        </span>
      </td>
      <td className="py-2 pe-5">
        <DirText dir="ltr">{client.slug}</DirText>
      </td>
      <td className="py-2 pe-5">{i18n._(role ?? ROLES.member)}</td>
      <td className="py-2">
        <div className="flex flex-wrap items-center gap-3">
          <Link to={`/w/${client.id}/settings/general`} className={ROW_LINK}>
            <Trans id="org.clients.settings">Settings</Trans>
            <span className="sr-only">
              {" "}
              <DirText>{client.name}</DirText>
            </span>
          </Link>
          <ArchiveControl workspace={client} />
        </div>
      </td>
    </tr>
  );
}

function ClientTable({ clients }: { clients: Workspace[] }) {
  const { t } = useLingui();
  return (
    // Positioned, so the hidden names of the row buttons stay inside the scroll box instead of widening the page.
    <div className="relative overflow-x-auto" data-testid="clients-scroll">
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

// Archived clients are hidden until asked for; the switch exists only when there is one to show.
function ArchivedFilter({
  clients,
  children,
}: {
  clients: Workspace[];
  children: (shown: Workspace[]) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? clients : clients.filter((client) => !client.archived_at);
  return (
    <>
      {clients.some((client) => client.archived_at) ? (
        <Switch
          label={<Trans id="org.clients.show_archived">Show archived clients</Trans>}
          isSelected={all}
          onChange={setAll}
        />
      ) : null}
      {shown.length > 0 ? (
        children(shown)
      ) : (
        <EmptyState
          kind="filtered-out"
          title={<Trans id="org.clients.all_archived">Every client is archived</Trans>}
          onClearFilters={() => setAll(true)}
        />
      )}
    </>
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
        <ArchivedFilter clients={clients}>{(shown) => <ClientTable clients={shown} />}</ArchivedFilter>
      )}
      <Dialog title={<Trans id="org.clients.add">Add client</Trans>} isOpen={open} onOpenChange={setOpen}>
        <AddClient
          templates={clients.filter((client) => !client.archived_at)}
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
