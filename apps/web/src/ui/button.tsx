import { useId } from "react";
import { Button as AriaButton, type ButtonProps } from "react-aria-components";

type Props = Omit<ButtonProps, "isDisabled"> & {
  /** The button cannot be used now: it stays focusable and says why through `reason` (NFR-A11Y-05). */
  "aria-disabled"?: boolean;
  /** Visible words that explain why the button is unavailable; linked to the button while it is. */
  reason?: string;
};

const BASE =
  "inline-flex min-h-10 pointer-coarse:min-h-11 items-center justify-center gap-3 rounded-md border border-border-control " +
  "bg-primary px-5 text-md font-medium text-on-primary outline-offset-2 focus-visible:outline-2 " +
  "focus-visible:outline-focus aria-disabled:opacity-60 aria-disabled:cursor-not-allowed";

// Every press, click and key handler of the caller: none may reach the element while the button is unavailable.
const CALLER_HANDLER = /^on(?:Press|Click|Key)/;

function withoutHandlers<T extends object>(props: T): T {
  return Object.fromEntries(Object.entries(props).filter(([name]) => !CALLER_HANDLER.test(name))) as T;
}

// The caller's class is added to the base classes (size, focus ring, unavailable look), never replaces them.
function withBase(className: ButtonProps["className"]): NonNullable<ButtonProps["className"]> {
  if (typeof className === "function") return (state) => `${BASE} ${className(state)}`;
  return className ? `${BASE} ${className}` : BASE;
}

/**
 * A React Aria button that never uses the native `disabled` state (it would drop focus and hide the reason). While
 * `aria-disabled` is set no handler of the caller is passed on whatever the library does, and the button cannot submit.
 */
export function Button({ "aria-disabled": unavailable = false, reason, className, ...rest }: Props) {
  const reasonId = useId();
  const explained = unavailable && reason !== undefined;
  return (
    <>
      <AriaButton
        {...(unavailable ? withoutHandlers(rest) : rest)}
        className={withBase(className)}
        {...(unavailable ? { type: "button" as const, "aria-disabled": true as const } : {})}
        {...(explained ? { "aria-describedby": reasonId } : {})}
      />
      {explained ? (
        <span id={reasonId} className="text-sm text-text-muted">
          {reason}
        </span>
      ) : null}
    </>
  );
}
