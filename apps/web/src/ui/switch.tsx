import { type ReactNode, useEffect, useRef } from "react";
import { Switch as AriaSwitch } from "react-aria-components";

/**
 * An on/off control (React Aria Switch) named by its label. While `busy` (its change is being saved) the control
 * itself is `aria-busy` and `busyText` is announced in a status, changes are ignored and it stays focusable: it is never
 * natively disabled.
 */
export function Switch({
  label,
  isSelected,
  onChange,
  busy = false,
  busyText,
}: {
  label: ReactNode;
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  busy?: boolean;
  busyText?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  // React Aria does not pass `aria-busy` on, so the state is set on the control's own element.
  useEffect(() => {
    if (busy) input.current?.setAttribute("aria-busy", "true");
    else input.current?.removeAttribute("aria-busy");
  }, [busy]);
  return (
    <>
      <AriaSwitch
        inputRef={input}
        isSelected={isSelected}
        onChange={(next) => {
          if (!busy) onChange(next);
        }}
        className="group flex min-h-6 pointer-coarse:min-h-11 items-center gap-3 outline-none"
      >
        <span className="flex h-6 w-11 items-center justify-start rounded-full border border-border-control bg-surface-2 p-0.5 group-data-[selected]:justify-end group-data-[selected]:bg-primary group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus">
          <span className="size-4 rounded-full bg-text" />
        </span>
        {label}
      </AriaSwitch>
      <span role="status" className="text-sm text-text-muted">
        {busy ? busyText : null}
      </span>
    </>
  );
}
