import { Trans } from "@lingui/react/macro";
import { ListBox, ListBoxItem, Popover } from "react-aria-components";
import { DirText } from "../ui/dir-text";

export interface Choice {
  id: string;
  name: string;
  archived_at?: string | null;
}

export const ArchivedMark = ({ choice }: { choice: Choice }) =>
  choice.archived_at ? (
    <span className="text-sm text-text-muted">
      {" "}
      <Trans id="shell.archived_mark">(Archived)</Trans>
    </span>
  ) : null;

export function ChoiceList() {
  return (
    <Popover className="w-(--trigger-width) rounded-md border border-border bg-surface shadow-lg">
      <ListBox className="max-h-72 overflow-auto p-2 outline-none">
        {(choice: Choice) => (
          <ListBoxItem
            id={choice.id}
            textValue={choice.name}
            className="min-h-6 pointer-coarse:min-h-11 cursor-default rounded-sm px-3 py-2 outline-none data-[focused]:bg-highlight"
          >
            <DirText>{choice.name}</DirText>
            <ArchivedMark choice={choice} />
          </ListBoxItem>
        )}
      </ListBox>
    </Popover>
  );
}
