import type { Ref } from "react";
import {
  TextField as AriaTextField,
  FieldError,
  Input,
  Label,
  type TextFieldProps,
} from "react-aria-components";

type Props = Omit<TextFieldProps, "isDisabled" | "isInvalid" | "children"> & {
  label: string;
  testId?: string;
  errorMessage?: string;
  /** A Latin value, such as a server address, that reads left to right even in an Arabic page. */
  ltr?: boolean;
  inputRef?: Ref<HTMLInputElement>;
};

export function TextField({ label, testId, errorMessage, ltr = false, inputRef, ...rest }: Props) {
  return (
    <AriaTextField {...rest} isInvalid={errorMessage !== undefined} className="flex flex-col gap-2">
      <Label className="text-sm font-medium">{label}</Label>
      <Input
        ref={inputRef}
        {...(testId ? { "data-testid": testId } : {})}
        // An address is Latin and reads left to right even in an Arabic page.
        {...(ltr || rest.type === "email" ? { dir: "ltr" } : {})}
        className="min-h-10 pointer-coarse:min-h-11 rounded-md border border-border-control bg-surface px-3 text-md outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
      />
      <FieldError className="text-sm text-danger">{errorMessage}</FieldError>
    </AriaTextField>
  );
}
