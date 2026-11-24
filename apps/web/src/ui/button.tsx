import { type Ref, useEffect, useId, useRef } from "react";
import { Button as AriaButton, type ButtonProps } from "react-aria-components";

type Props = Omit<ButtonProps, "isDisabled"> & {
  /** The button cannot be used now: it stays focusable and says why through `reason`. */
  "aria-disabled"?: boolean;
  reason?: string;
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

const BASE =
  "inline-flex min-h-10 pointer-coarse:min-h-11 items-center justify-center gap-3 rounded-md border border-border-control " +
  "bg-primary px-5 text-md font-medium text-on-primary outline-offset-2 focus-visible:outline-2 " +
  "focus-visible:outline-focus aria-disabled:opacity-60 aria-disabled:cursor-not-allowed";

const CALLER_HANDLER = /^on(?:Press|Click|Key)/;

function withoutHandlers<T extends object>(props: T): T {
  return Object.fromEntries(Object.entries(props).filter(([name]) => !CALLER_HANDLER.test(name))) as T;
}

function withBase(className: ButtonProps["className"]): NonNullable<ButtonProps["className"]> {
  if (typeof className === "function") return (state) => `${BASE} ${className(state)}`;
  return className ? `${BASE} ${className}` : BASE;
}

/** Never uses the native `disabled` state: it would drop focus and hide the reason. */
export function Button({
  "aria-disabled": unavailable = false,
  busy = false,
  reason,
  className,
  ref: outer,
  ...rest
}: Props) {
  const reasonId = useId();
  const ref = useRef<HTMLButtonElement | null>(null);
  const setRef = (node: HTMLButtonElement | null) => {
    ref.current = node;
    if (typeof outer === "function") outer(node);
    else if (outer) outer.current = node;
  };
  const explained = unavailable && reason !== undefined;
  // React Aria drops `aria-busy` from the props it passes on, so a submitting button's state is set on the element.
  useEffect(() => {
    if (busy) ref.current?.setAttribute("aria-busy", "true");
    else ref.current?.removeAttribute("aria-busy");
  }, [busy]);
  return (
    <>
      <AriaButton
        ref={setRef}
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
