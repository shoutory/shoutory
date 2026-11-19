import {
  TextField as AriaTextField,
  FieldError,
  Input,
  Label,
  type TextFieldProps,
} from "react-aria-components";

type Props = Omit<TextFieldProps, "isDisabled" | "isInvalid" | "children"> & {
  label: string;
  /** The server's refusal of this field, in words; it is tied to the input and marks it invalid. */
  errorMessage?: string;
};

/** A labelled text input whose error is text beside the field, never colour alone (WCAG 3.3.1). */
export function TextField({ label, errorMessage, ...rest }: Props) {
  return (
    <AriaTextField {...rest} isInvalid={errorMessage !== undefined} className="flex flex-col gap-2">
      <Label className="text-sm font-medium">{label}</Label>
      <Input
        // An address is Latin and reads left to right even in an Arabic page.
        {...(rest.type === "email" ? { dir: "ltr" } : {})}
        className="min-h-10 pointer-coarse:min-h-11 rounded-md border border-border-control bg-surface px-3 text-md outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
      />
      <FieldError className="text-sm text-danger">{errorMessage}</FieldError>
    </AriaTextField>
  );
}
