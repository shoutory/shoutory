import { Trans } from "@lingui/react/macro";
import { type ReactNode, useState } from "react";
import { Button, ComboBox, Input, Label } from "react-aria-components";
import { useNavigate, useParams } from "react-router";
import { type Choice, ChoiceList } from "./choice-list";
import { Palette } from "./palette";
import type { Organization, Workspace } from "./shell-data";

// A ComboBox with search (ux-spec X-01); the label is the caller's own words.
function Switcher({
  label,
  choices,
  selectedId,
  onSelect,
}: {
  label: ReactNode;
  choices: Choice[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ComboBox
      defaultItems={choices}
      selectedKey={selectedId}
      onSelectionChange={(key) => key !== null && onSelect(String(key))}
      className="flex items-center gap-2"
    >
      <Label className="text-sm">{label}</Label>
      <div className="flex items-center gap-1">
        <Input className="min-h-10 pointer-coarse:min-h-11 rounded-md border border-border-control bg-surface px-3 text-md" />
        <Button className="min-h-10 min-w-10 pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-md border border-border-control">
          <span aria-hidden="true">▾</span>
        </Button>
      </div>
      <ChoiceList />
    </ComboBox>
  );
}

/**
 * The top bar's scope controls (ux-spec X-01, X-02): the organization switcher only filters the workspace list by
 * organization_id (R397 2); the workspace switcher lists the workspaces of the chosen organization and is absent when
 * there is nothing else to choose; the palette searches the same list.
 */
export function Switchers({
  organizations,
  workspaces,
}: {
  organizations: Organization[];
  workspaces: Workspace[];
}) {
  const navigate = useNavigate();
  const { ws } = useParams();
  const current = workspaces.find((workspace) => workspace.id === ws);
  // The choice belongs to the workspace it was made on: opening another workspace follows that workspace's organization.
  const [chosen, setChosen] = useState<{ on: string | undefined; id: string } | null>(null);
  const organizationId =
    chosen && chosen.on === current?.id ? chosen.id : (current?.organization_id ?? organizations[0]?.id);
  const organization = organizations.find((candidate) => candidate.id === organizationId);
  const visible = workspaces.filter((workspace) => workspace.organization_id === organizationId);

  return (
    <>
      {/* A personal organization is the person's own space: there is nothing to switch between. */}
      {organization && organization.type !== "personal" ? (
        <Switcher
          label={<Trans id="shell.switcher.organization">Organization</Trans>}
          choices={organizations}
          selectedId={organizationId ?? null}
          onSelect={(id) => setChosen({ on: current?.id, id })}
        />
      ) : null}
      {visible.some((workspace) => workspace.id !== current?.id) ? (
        <Switcher
          label={<Trans id="shell.switcher.workspace">Workspace</Trans>}
          choices={visible}
          selectedId={
            visible.some((workspace) => workspace.id === current?.id) ? (current?.id ?? null) : null
          }
          onSelect={(id) => void navigate(`/w/${id}`)}
        />
      ) : null}
      <Palette workspaces={visible} />
    </>
  );
}
