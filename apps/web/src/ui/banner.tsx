import type { ReactNode } from "react";

type Tone = "info" | "attention" | "danger";

const TONES: Record<Tone, string> = {
  info: "border-info bg-info-bg",
  attention: "border-attention bg-attention-bg",
  danger: "border-danger bg-danger-bg",
};

export function Banner({
  tone,
  children,
  announce = true,
}: {
  tone: Tone;
  children: ReactNode;
  /** `false` when the caller keeps its own live region around the banner (a live region must be mounted before its text). */
  announce?: boolean;
}) {
  return (
    <div
      {...(announce ? { role: tone === "danger" ? "alert" : "status" } : {})}
      className={`rounded-md border-s-4 px-5 py-4 text-md text-text ${TONES[tone]}`}
    >
      {children}
    </div>
  );
}
