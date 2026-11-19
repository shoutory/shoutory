import type { ReactNode } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";

/** One option of a `Choices` group. */
export function Choice({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Radio value={value} className="flex min-h-6 pointer-coarse:min-h-11 items-center gap-3">
      {children}
    </Radio>
  );
}

/** A labelled group of radio options, one chosen. */
export function Choices({
  label,
  value,
  onChange,
  children,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <RadioGroup value={value} onChange={onChange} className="flex flex-col gap-2">
      <Label className="text-sm font-medium">{label}</Label>
      {children}
    </RadioGroup>
  );
}
