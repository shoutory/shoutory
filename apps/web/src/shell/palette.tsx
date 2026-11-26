import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import {
  Autocomplete,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  SearchField,
  useFilter,
} from "react-aria-components";
import { useNavigate } from "react-router";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DirText } from "../ui/dir-text";
import { ArchivedMark } from "./choice-list";
import type { Workspace } from "./shell-data";

export function Palette({ workspaces }: { workspaces: Workspace[] }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { contains } = useFilter({ sensitivity: "base" });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <Button onPress={() => setOpen(true)} className="max-w-full flex-wrap">
        <Trans id="shell.palette.title">Switch workspace</Trans>
        <kbd dir="ltr" className="text-sm text-on-primary">
          Ctrl/Cmd+K
        </kbd>
      </Button>
      <Dialog
        title={<Trans id="shell.palette.title">Switch workspace</Trans>}
        isOpen={open}
        onOpenChange={setOpen}
      >
        {/* The filter text lives in the Autocomplete, which goes with the dialog: a reopened palette starts clean. */}
        <Autocomplete filter={contains}>
          <SearchField autoFocus className="flex flex-col gap-2">
            <Label>
              <Trans id="shell.palette.search">Search workspaces</Trans>
            </Label>
            <Input
              data-testid="palette-search"
              className="min-h-10 pointer-coarse:min-h-11 rounded-md border border-border-control bg-surface px-3 text-md"
            />
          </SearchField>
          <ListBox
            items={workspaces}
            autoFocus="first"
            onAction={(key) => {
              setOpen(false);
              void navigate(`/w/${String(key)}`);
            }}
            renderEmptyState={() => (
              <p className="p-3 text-text-muted">
                <Trans id="shell.palette.empty">Nothing found</Trans>
              </p>
            )}
            className="max-h-72 overflow-auto p-2 outline-none"
          >
            {(workspace: Workspace) => (
              <ListBoxItem
                id={workspace.id}
                textValue={workspace.name}
                className="min-h-6 pointer-coarse:min-h-11 cursor-default rounded-sm px-3 py-2 outline-none data-[focused]:bg-highlight"
              >
                <DirText>{workspace.name}</DirText>
                <ArchivedMark choice={workspace} />
              </ListBoxItem>
            )}
          </ListBox>
        </Autocomplete>
      </Dialog>
    </>
  );
}
