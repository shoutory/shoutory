import { Trans, useLingui } from "@lingui/react/macro";
import { ROLE_PERMISSIONS } from "@shoutory/core/authz";
import { useRef, useState } from "react";
import { Form, Label, Radio, RadioGroup } from "react-aria-components";
import { useNavigate, useParams, useRevalidator } from "react-router";
import { z } from "zod";
import { useLoad } from "../account/use-load";
import { authCopy } from "../auth/auth-copy";
import { SubmitButton, useAction } from "../auth/auth-frame";
import { type ApiError, request } from "../http/client";
import { NotFoundPage } from "../pages/system-pages";
import { useShellData, type Workspace } from "../shell/shell-data";
import { Button } from "../ui/button";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { ZonePicker } from "../zones/zone-picker";
import { ArchiveControl } from "./archive";
import { SWATCHES } from "./swatches";
import { AvatarPicker } from "./workspace-avatar";

const MAX_NAME = 128;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const profileSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  colour: z.string().nullable(),
  default_tz: z.string(),
});
type Profile = z.infer<typeof profileSchema>;

interface Draft {
  name: string;
  slug: string;
  colour: string | null;
  zone: string;
}
const draftOf = (profile: Profile): Draft => ({
  name: profile.name,
  slug: profile.slug,
  colour: profile.colour,
  zone: profile.default_tz,
});

function changesOf(draft: Draft, saved: Profile) {
  const changes: Record<string, string> = {};
  if (draft.name.trim() !== saved.name) changes.name = draft.name.trim();
  if (draft.slug.trim() !== saved.slug) changes.slug = draft.slug.trim();
  if (draft.colour !== null && draft.colour !== saved.colour) changes.colour = draft.colour;
  if (draft.zone !== saved.default_tz) changes.default_tz = draft.zone;
  return changes;
}

function saveCopy(error: ApiError) {
  // A conflict with a reason (an archived workspace) is not a taken address name.
  if (error.code === "conflict" && !error.details?.reason)
    return {
      what: <Trans id="settings.general.slug_taken.what">That address name is already used</Trans>,
      meaning: (
        <Trans id="settings.general.slug_taken.meaning">
          Another client of this organization has it. Choose another. Nothing was changed.
        </Trans>
      ),
    };
  if (error.state === "forbidden")
    return {
      what: <Trans id="settings.general.forbidden.what">You can no longer change these settings</Trans>,
      meaning: <Trans id="settings.general.forbidden.meaning">Your role changed. Nothing was saved.</Trans>,
    };
  return authCopy("link", error);
}

function Colours({
  value,
  onChange,
  readOnly,
}: {
  value: string | null;
  onChange: (colour: string) => void;
  readOnly: boolean;
}) {
  const { i18n } = useLingui();
  return (
    <RadioGroup
      name="colour"
      value={value}
      onChange={onChange}
      isReadOnly={readOnly}
      className="flex flex-col gap-2"
    >
      <Label className="text-sm font-medium">
        <Trans id="settings.general.colour">Colour</Trans>
      </Label>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {SWATCHES.map((swatch) => (
          <Radio
            key={swatch.colour}
            value={swatch.colour}
            className="flex min-h-6 pointer-coarse:min-h-11 items-center gap-3 rounded-md outline-offset-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
          >
            {({ isSelected }) => (
              <>
                <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="11" fill={swatch.colour} />
                  {isSelected ? (
                    <path d="M7 12.5l3.5 3.5L17 9" fill="none" stroke={swatch.label} strokeWidth="2.5" />
                  ) : null}
                </svg>
                {i18n._(swatch.name)}
              </>
            )}
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}

function useGeneral(profile: Profile) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [saved, setSaved] = useState(profile);
  const [draft, setDraft] = useState(draftOf(profile));
  const [done, setDone] = useState(false);
  const save = useAction(
    async () => {
      const body = changesOf(draft, saved);
      const answer = await request(profileSchema, `/api/v1/workspaces/${saved.id}`, {
        method: "PATCH",
        body,
      });
      // A failure to reload the lists is shown by the top bar; it is not a failed save.
      setSaved(answer);
      setDraft(draftOf(answer));
      setDone(true);
      void revalidator.revalidate();
    },
    (error) => {
      if (error.state === "session_expired")
        void navigate(`/sign-in?return-to=${encodeURIComponent(`/w/${saved.id}/settings/general`)}`);
      if (error.state === "forbidden") void revalidator.revalidate();
    },
  );
  const edit = (next: Partial<Draft>) => {
    setDraft((now) => ({ ...now, ...next }));
    setDone(false);
  };
  return { draft, edit, dirty: Object.keys(changesOf(draft, saved)).length > 0, done, save, saved };
}

type Invalid = { name: boolean; slug: boolean };

function TextFields({
  g,
  canEdit,
  invalid,
  onValid,
}: {
  g: ReturnType<typeof useGeneral>;
  canEdit: boolean;
  invalid: Invalid;
  onValid: (field: keyof Invalid) => void;
}) {
  const { t } = useLingui();
  const nameBad = t({ id: "onboarding.name_required", message: "Enter a name." });
  const slugBad = t({ id: "settings.slug_bad", message: "Use lowercase letters, digits and dashes." });
  return (
    <>
      <TextField
        label={t({ id: "settings.general.name", message: "Name" })}
        name="name"
        maxLength={MAX_NAME}
        isReadOnly={!canEdit}
        value={g.draft.name}
        onChange={(name) => {
          g.edit({ name });
          onValid("name");
        }}
        {...(invalid.name ? { errorMessage: nameBad } : {})}
      />
      <TextField
        label={t({ id: "settings.general.slug", message: "Address name" })}
        name="slug"
        isReadOnly={!canEdit}
        value={g.draft.slug}
        onChange={(slug) => {
          g.edit({ slug });
          onValid("slug");
        }}
        {...(invalid.slug ? { errorMessage: slugBad } : {})}
      />
    </>
  );
}

function GeneralForm({ profile, canEdit }: { profile: Profile; canEdit: boolean }) {
  const { t } = useLingui();
  const form = useRef<HTMLFormElement>(null);
  const g = useGeneral(profile);
  const need = t({ id: "settings.need_admin", message: "You need the admin role to save changes." });
  const [invalid, setInvalid] = useState<Invalid>({ name: false, slug: false });
  const clear = (name: keyof Invalid) => setInvalid((now) => ({ ...now, [name]: false }));
  const submit = () => {
    // Enter in a field still submits while the button is unavailable.
    if (!canEdit) return;
    const bad = { name: g.draft.name.trim() === "", slug: !SLUG.test(g.draft.slug.trim()) };
    setInvalid(bad);
    const first = (["name", "slug"] as const).find((field) => bad[field]);
    if (first) form.current?.querySelector<HTMLInputElement>(`input[name="${first}"]`)?.focus();
    else if (g.dirty) void g.save.run();
  };
  return (
    <Form
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex max-w-md flex-col gap-5"
    >
      <TextFields g={g} canEdit={canEdit} invalid={invalid} onValid={clear} />
      <Colours value={g.draft.colour} onChange={(colour) => g.edit({ colour })} readOnly={!canEdit} />
      <ZonePicker
        label={t({ id: "account.profile.zone", message: "Time zone" })}
        value={g.draft.zone}
        onChange={(zone) => g.edit({ zone })}
        isReadOnly={!canEdit}
      />
      {canEdit ? (
        <SubmitButton pending={g.save.pending} online={g.save.online}>
          <Trans id="account.profile.save">Save</Trans>
        </SubmitButton>
      ) : (
        <Button aria-disabled reason={need}>
          <Trans id="account.profile.save">Save</Trans>
        </Button>
      )}
      <p role="status">
        {g.dirty ? <Trans id="settings.general.unsaved">Unsaved changes</Trans> : null}
        {!g.dirty && g.done ? <Trans id="account.profile.saved">Saved</Trans> : null}
      </p>
      {g.save.failure ? (
        <ErrorPanel focusOnMount error={g.save.failure} {...saveCopy(g.save.failure)} />
      ) : null}
    </Form>
  );
}

const WorkspaceHeading = () => (
  <h1 className="font-heading text-2xl">
    <Trans id="settings.general.title">General</Trans>
  </h1>
);

// The profile is read here because the workspace lists hold no colour or zone.
function General({ workspace }: { workspace: Workspace }) {
  const { state, reload } = useLoad(profileSchema, `/api/v1/workspaces/${workspace.id}`);
  const permissions: Readonly<Record<string, readonly string[] | undefined>> = ROLE_PERMISSIONS;
  const allowed = permissions[workspace.role]?.includes("settings.manage") ?? false;
  // An archived workspace is read-only; the banner above offers Restore.
  const canEdit = allowed && !workspace.archived_at;
  return (
    <>
      <WorkspaceHeading />
      <AvatarPicker workspace={workspace} canEdit={canEdit} />
      {state.status === "loading" ? (
        <p role="status">
          <Trans id="system.loading">Loading</Trans>
        </p>
      ) : null}
      {state.status === "failed" ? (
        <ErrorPanel focusOnMount error={state.error} onRetry={reload} {...authCopy("link", state.error)} />
      ) : null}
      {state.status === "done" ? <GeneralForm profile={state.data} canEdit={canEdit} /> : null}
      {workspace.archived_at ? null : <ArchiveControl workspace={workspace} />}
    </>
  );
}

export function GeneralPage() {
  const { ws } = useParams();
  const data = useShellData();
  if ("error" in data) return <WorkspaceHeading />;
  const workspace = data.workspaces.find((candidate) => candidate.id === ws);
  return workspace ? <General workspace={workspace} /> : <NotFoundPage />;
}
