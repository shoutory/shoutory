import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Dialog } from "../ui/dialog";

// Every keyboard shortcut of the app, so the list cannot fall behind a new one.
const SHORTCUTS: readonly { keys: string; does: MessageDescriptor }[] = [
  { keys: "Ctrl/Cmd+K", does: msg({ id: "shell.shortcuts.switch", message: "Switch workspace" }) },
];

export function ShortcutsDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <Dialog
      title={<Trans id="shell.shortcuts.title">Keyboard shortcuts</Trans>}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.keys} className="contents">
            <dt>
              <kbd dir="ltr" className="font-mono">
                {shortcut.keys}
              </kbd>
            </dt>
            <dd>{t(shortcut.does)}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
