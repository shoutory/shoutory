import {
  Select as AriaSelect,
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
} from "react-aria-components";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A labelled list of options with one chosen (React Aria): the label is the accessible name, a keyboard opens it and
 * Escape closes it. `hideLabel` keeps the label for assistive technology only, for a Select inside a table row whose
 * column already says what it is.
 */
export function Select({
  label,
  value,
  onChange,
  options,
  hideLabel = false,
  unavailable = false,
  reason,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  hideLabel?: boolean;
  /** The list cannot be used now: it stays focusable, does not open, and says why through `reason`. */
  unavailable?: boolean;
  reason?: string;
}) {
  return (
    <AriaSelect
      selectedKey={value}
      // A closed list still selects on ArrowLeft and ArrowRight, so an unavailable one ignores every change.
      onSelectionChange={(key) => {
        if (!unavailable && key !== null) onChange(String(key));
      }}
      className="flex flex-col gap-2"
      {...(unavailable ? { isOpen: false, onOpenChange: () => undefined } : {})}
    >
      <Label className={hideLabel ? "sr-only" : "text-sm font-medium"}>{label}</Label>
      <Button
        {...(unavailable ? { "aria-disabled": true } : {})}
        className="flex min-h-10 pointer-coarse:min-h-11 items-center justify-between gap-3 rounded-md border border-border-control bg-surface px-3 text-md outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
      >
        <SelectValue />
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </Button>
      <span role="status" className="text-sm text-text-muted">
        {unavailable ? reason : null}
      </span>
      <Popover className="w-(--trigger-width) rounded-md border border-border bg-surface shadow-lg">
        <ListBox className="max-h-72 overflow-auto p-2 outline-none">
          {options.map((option) => (
            <ListBoxItem
              key={option.value}
              id={option.value}
              textValue={option.label}
              className="min-h-6 pointer-coarse:min-h-11 cursor-default rounded-sm px-3 py-2 outline-none data-[focused]:bg-highlight"
            >
              {option.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
