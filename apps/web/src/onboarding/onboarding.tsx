import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { useNavigate, useRevalidator } from "react-router";
import { z } from "zod";
import { readZone } from "../account/prefs";
import { authCopy } from "../auth/auth-copy";
import { SubmitButton, useAction } from "../auth/auth-frame";
import { keyedPost } from "../http/client";
import type { Organization } from "../shell/shell-data";
import { Choice, Choices } from "../ui/choices";
import { DirText } from "../ui/dir-text";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { ZonePicker } from "../zones/zone-picker";

type OrgType = Organization["type"];
const MAX_NAME = 128;
const made = z.object({ id: z.string(), name: z.string(), type: z.enum(["agency", "team", "personal"]) });
const workspaceMade = z.object({ id: z.string() });

interface Target {
  id: string;
  name: string;
  type: OrgType;
}

// The organization is kept once made, so a retry after the workspace call failed sends only the workspace.
function useOnboarding(resume: Organization | undefined) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [target, setTarget] = useState<Target | null>(resume ?? null);
  const [orgName, setOrgName] = useState("");
  const [type, setType] = useState<OrgType>("agency");
  const [typed, setTyped] = useState<string | null>(null);
  const [zone, setZone] = useState(readZone);
  const [postOrganization] = useState(keyedPost);
  const [postWorkspace] = useState(keyedPost);
  const workspaceName = typed ?? target?.name ?? orgName;
  const submit = async () => {
    let org = target;
    if (!org) {
      const row = await postOrganization(made, "/api/v1/organizations", { name: orgName.trim(), type });
      org = { id: row.id, name: row.name, type: row.type };
      setTarget(org);
      // So a reload from here resumes this organization instead of starting another.
      await revalidator.revalidate();
    }
    const body = { organization_id: org.id, name: workspaceName.trim(), default_tz: zone };
    const workspace = await postWorkspace(workspaceMade, "/api/v1/workspaces", body);
    await revalidator.revalidate();
    await navigate(`/w/${workspace.id}`);
  };
  const create = useAction(submit, (error) => {
    if (error.state === "session_expired") void navigate("/sign-in?return-to=%2F");
  });
  const edited = typed !== null;
  return {
    target,
    orgName,
    setOrgName,
    type,
    setType,
    workspaceName,
    edited,
    setTyped,
    zone,
    setZone,
    create,
  };
}

type Fields = { organization: boolean; workspace: boolean };

function useValidation(s: ReturnType<typeof useOnboarding>) {
  const form = useRef<HTMLFormElement>(null);
  const [invalid, setInvalid] = useState<Fields>({ organization: false, workspace: false });
  const clear = (field: keyof Fields) => setInvalid((now) => ({ ...now, [field]: false }));
  const submit = () => {
    const bad = { organization: !s.target && !s.orgName.trim(), workspace: !s.workspaceName.trim() };
    setInvalid(bad);
    const first = (["organization", "workspace"] as const).find((field) => bad[field]);
    if (!first) return void s.create.run();
    form.current?.querySelector<HTMLInputElement>(`input[name="${first}"]`)?.focus();
  };
  return { form, invalid, clear, submit };
}

function WorkspaceStep({
  s,
  invalid,
  onTyped,
}: {
  s: ReturnType<typeof useOnboarding>;
  invalid: boolean;
  onTyped: (value: string) => void;
}) {
  const { t } = useLingui();
  const labels: Record<OrgType, string> = {
    agency: t({ id: "onboarding.workspace_agency", message: "Name of your first client" }),
    team: t({ id: "onboarding.workspace_team", message: "Name of your first workspace" }),
    personal: t({ id: "onboarding.workspace_personal", message: "Name of your workspace" }),
  };
  return (
    <>
      <TextField
        label={labels[s.target?.type ?? s.type]}
        name="workspace"
        testId="onboarding-workspace"
        maxLength={MAX_NAME}
        value={s.workspaceName}
        onChange={onTyped}
        {...(invalid
          ? { errorMessage: t({ id: "onboarding.name_required", message: "Enter a name." }) }
          : {})}
      />
      <ZonePicker
        label={t({ id: "account.profile.zone", message: "Time zone" })}
        value={s.zone}
        onChange={s.setZone}
      />
    </>
  );
}

export function Onboarding({
  resume,
  focusHeading = false,
}: {
  resume?: Organization | undefined;
  focusHeading?: boolean;
}) {
  const s = useOnboarding(resume);
  const v = useValidation(s);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  return (
    <Form
      ref={v.form}
      onSubmit={(event) => {
        event.preventDefault();
        v.submit();
      }}
      className="flex max-w-md flex-col gap-5"
    >
      <h1 ref={heading} tabIndex={-1} className="font-heading text-2xl">
        {s.target ? (
          <Trans id="onboarding.resume_title">Finish setting up</Trans>
        ) : (
          <Trans id="onboarding.title">Set up Shoutory</Trans>
        )}
      </h1>
      {s.target ? (
        <p>
          <span className="text-text-muted">
            <Trans id="onboarding.resume_org">Organization</Trans>
          </span>{" "}
          <DirText>{s.target.name}</DirText>
        </p>
      ) : (
        <OrganizationStep
          name={s.orgName}
          invalid={v.invalid.organization}
          onName={(value) => {
            s.setOrgName(value);
            v.clear("organization");
            // An unedited workspace name follows the organization's, so its flag clears with it.
            if (!s.edited) v.clear("workspace");
          }}
          type={s.type}
          onType={s.setType}
        />
      )}
      <WorkspaceStep
        s={s}
        invalid={v.invalid.workspace}
        onTyped={(value) => {
          s.setTyped(value);
          v.clear("workspace");
        }}
      />
      <SubmitButton testId="onboarding-create" pending={s.create.pending} online={s.create.online}>
        <Trans id="onboarding.create">Create</Trans>
      </SubmitButton>
      {s.create.failure ? (
        <ErrorPanel focusOnMount error={s.create.failure} {...authCopy("link", s.create.failure)} />
      ) : null}
    </Form>
  );
}

function OrganizationStep({
  name,
  invalid,
  onName,
  type,
  onType,
}: {
  name: string;
  invalid: boolean;
  onName: (value: string) => void;
  type: OrgType;
  onType: (value: OrgType) => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <TextField
        label={t({ id: "onboarding.org_name", message: "Organization name" })}
        name="organization"
        testId="onboarding-organization"
        maxLength={MAX_NAME}
        value={name}
        onChange={onName}
        {...(invalid
          ? { errorMessage: t({ id: "onboarding.name_required", message: "Enter a name." }) }
          : {})}
      />
      <Choices
        label={<Trans id="onboarding.type">Type</Trans>}
        value={type}
        onChange={(next) => onType(next === "team" || next === "personal" ? next : "agency")}
      >
        <Choice value="agency">
          <Trans id="onboarding.type_agency">Agency</Trans>
        </Choice>
        <Choice value="team">
          <Trans id="onboarding.type_team">Team</Trans>
        </Choice>
        <Choice value="personal" testId="onboarding-type-personal">
          <Trans id="onboarding.type_personal">Just me</Trans>
        </Choice>
      </Choices>
      <p className="text-text-muted">
        {type === "agency" ? (
          <Trans id="onboarding.helper_agency">
            Each client you add gets its own channels, calendar and approvals.
          </Trans>
        ) : null}
        {type === "team" ? (
          <Trans id="onboarding.helper_team">
            Your team works together in one workspace with shared channels and approvals.
          </Trans>
        ) : null}
        {type === "personal" ? (
          <Trans id="onboarding.helper_personal">Just you: one workspace and no switchers.</Trans>
        ) : null}
      </p>
    </>
  );
}
