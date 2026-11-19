import type { ReactNode } from "react";

type Tone = "info" | "attention" | "danger";

const TONES: Record<Tone, string> = {
  info: "border-info bg-info-bg",
  attention: "border-attention bg-attention-bg",
  danger: "border-danger bg-danger-bg",
};

/** A message that stays on the screen until the cause is gone. Only a danger banner is an alert (WI-F12). */
export function Banner({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`rounded-md border-s-4 px-5 py-4 text-md text-text ${TONES[tone]}`}
    >
      {children}
    </div>
  );
}
