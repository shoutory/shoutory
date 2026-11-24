import { useLingui } from "@lingui/react/macro";
import { PASSWORD_MIN_LENGTH } from "@shoutory/core/password-limits";
import { useState } from "react";
import type { ApiError } from "../http/client";
import { TextField } from "../ui/text-field";

// Checks the length only: the server decides everything else.
export function useNewPassword() {
  const [value, setValue] = useState("");
  const [short, setShort] = useState(false);
  return {
    value,
    // Only a refusal of the password empties it; a failure of the server or the network keeps it for Retry.
    clearIfRefused: (error: ApiError) => {
      if (error.code === "validation_failed") setValue("");
    },
    clear: () => setValue(""),
    check: () => {
      const tooShort = [...value].length < PASSWORD_MIN_LENGTH;
      setShort(tooShort);
      return !tooShort;
    },
    props: { value, onChange: setValue, short },
  };
}

export function NewPasswordField({
  label,
  name = "password",
  value,
  onChange,
  short,
  testId,
}: {
  label: string;
  name?: string;
  testId?: string;
  value: string;
  onChange: (value: string) => void;
  short: boolean;
}) {
  const { t } = useLingui();
  const min = PASSWORD_MIN_LENGTH;
  return (
    <TextField
      label={label}
      name={name}
      {...(testId ? { testId } : {})}
      type="password"
      autoComplete="new-password"
      isRequired
      value={value}
      onChange={onChange}
      {...(short
        ? { errorMessage: t({ id: "auth.password.short", message: `Use at least ${min} characters.` }) }
        : {})}
    />
  );
}
