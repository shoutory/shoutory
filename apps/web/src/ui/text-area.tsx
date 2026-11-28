import type { Ref } from "react";
import {
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  FieldError,
  Label,
  type TextFieldProps,
} from "react-aria-components";

type Props = Omit<TextFieldProps, "isDisabled" | "isInvalid" | "children"> & {
  label: string;
  testId?: string;
  /** Names the field for a link that jumps to it. */
  field?: string;
  errorMessage?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  rows?: number;
};

/** A field for the words of a person: each one reads in its own direction, whatever the page's. */
export function TextArea({ label, testId, field, errorMessage, inputRef, rows = 5, ...rest }: Props) {
  return (
    <AriaTextField {...rest} isInvalid={errorMessage !== undefined} className="flex flex-col gap-2">
      <Label className="text-sm font-medium">{label}</Label>
      <AriaTextArea
        ref={inputRef}
        rows={rows}
        dir="auto"
        {...(field ? { "data-field": field } : {})}
        {...(testId ? { "data-testid": testId } : {})}
        className="min-h-24 rounded-md border border-border-control bg-surface px-3 py-2 text-md text-start outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
      />
      <FieldError className="text-sm text-danger">{errorMessage}</FieldError>
    </AriaTextField>
  );
}
